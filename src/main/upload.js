/*
 * Minio Javascript Library for Amazon S3 Compatible Cloud Storage, (C) 2015 Minio, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import BlockStream2 from 'block-stream2';
import Concat from 'concat-stream';
import Crypto from 'crypto';
import ParseXml from 'xml-parser';
import Stream from 'stream';
import Through2 from 'through2';
import Xml from 'xml';

import { signV4 } from './signing.js';
import { parseError } from './xml-parsers.js';
import { uriResourceEscape, uriEscape } from './helpers.js';

export function initiateNewMultipartUpload(transport, params, bucket, key, contentType, cb) {
    var requestParams = {
      host: params.host,
      port: params.port,
      protocol: params.protocol,
      path: `/${bucket}/${uriResourceEscape(key)}?uploads`,
      method: 'POST',
      headers: {
        'Content-Type': contentType
      }
    }

    signV4(requestParams, '', params.accessKey, params.secretKey)

    var request = transport.request(requestParams, (response) => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      response.pipe(Concat(xml => {
        var parsedXml = ParseXml(xml.toString()),
          uploadId = null
        parsedXml.root.children.forEach(element => {
          if (element.name === 'UploadId') {
            uploadId = element.content
          }
        })

        if (uploadId) {
          return cb(null, uploadId)
        }
        cb('unable to get upload id')
      }))
    })
    request.end()
  }

export function streamUpload(transport, params, bucket, key, contentType, uploadId, partsArray, totalSize, r, cb) {
  var part = 1,
    errored = null,
    etags = [],
    // compute size
    partSize = calculatePartSize(totalSize),
    totalSeen = 0

  r.on('finish', function() {})
  r.pipe(BlockStream2({
    size: partSize,
    zeroPadding: false
  })).pipe(Through2.obj(function(data, enc, done) {
      if (errored) {
        return done()
      }

      if (data.length < partSize) {
        var expectedSize = totalSize - totalSeen
        if (expectedSize != data.length) {
          errored = 'actual size does not match specified size'
          return done()
        }
      }

      totalSeen += data.length
      var curPart = part
      part = part + 1
      if (partsArray.length > 0) {
        var curJob = partsArray.shift(),
          hash = Crypto.createHash('md5')
        hash.update(data)
        var md5 = hash.digest('hex').toLowerCase()
        if (curJob.etag === md5) {
          etags.push({
            part: curPart,
            etag: md5
          })
          done()
          return
        }
      }

      var dataStream = new Stream.Readable()
      dataStream.push(data)
      dataStream.push(null)
      dataStream._read = function() {}
      doPutObject(transport, params, bucket, key, contentType, data.length,
        uploadId, curPart, dataStream, (e, etag) => {
          if (errored) {
            return done()
          }
          if (e) {
            errored = e
            return done()
          }
          etags.push({
            part: curPart,
            etag: etag
          })
          return done()
        })
    },
    function(done) {
      done()
      if (errored) {
        return cb(errored)
      }
      if (totalSeen !== totalSize) {
        return cb('actual size does not match specified size', null)
      }
      return cb(null, etags)
    }))

  function calculatePartSize(size) {
    var minimumPartSize = 5 * 1024 * 1024, // 5MB
      maximumPartSize = 5 * 1025 * 1024 * 1024,
      // using 10000 may cause part size to become too small, and not fit the entire object in
      partSize = Math.floor(size / 9999)

    if (partSize > maximumPartSize) {
      return maximumPartSize
    }
    return Math.max(minimumPartSize, partSize)
  }
}

export function doPutObject(transport, params, bucket, key, contentType, size, uploadId, part, r, cb) {
  var query = ''
  if (part) {
    query = `?partNumber=${part}&uploadId=${uploadId}`
  }
  if (contentType === null || contentType === '') {
    contentType = 'application/octet-stream'
  }

  r.pipe(Concat(data => {
    if (data.length !== size) {
      return cb('actual size !== specified size')
    }
    var hash256 = Crypto.createHash('sha256'),
      hashMD5 = Crypto.createHash('md5')

    hash256.update(data)
    hashMD5.update(data)

    var sha256 = hash256.digest('hex').toLowerCase(),
      md5 = hashMD5.digest('base64'),
      requestParams = {
        host: params.host,
        port: params.port,
        protocol: params.protocol,
        path: `/${bucket}/${uriResourceEscape(key)}${query}`,
        method: 'PUT',
        headers: {
          'Content-Length': size,
          'Content-Type': contentType,
          'Content-MD5': md5
        }
      }

    signV4(requestParams, sha256, params.accessKey, params.secretKey)

    var dataStream = new Stream.Readable()
    dataStream._read = function() {}
    dataStream.push(data)
    dataStream.push(null)

    var request = transport.request(requestParams, (response) => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      var etag = response.headers.etag
      cb(null, etag)
    })
    dataStream.pipe(request)
  }, function(done) {
    done()
  }))
  r.on('error', (e) => {
    cb(e)
  })
}

export function completeMultipartUpload(transport, params, bucket, key, uploadId, etags, cb) {
  var requestParams = {
    host: params.host,
    port: params.port,
    protocol: params.protocol,
    path: `/${bucket}/${uriResourceEscape(key)}?uploadId=${uploadId}`,
    method: 'POST'
  },
      parts = []

  etags.forEach(element => {
    parts.push({
      Part: [{
        PartNumber: element.part
      }, {
        ETag: element.etag
      }]
    })
  })

  var payloadObject = {
      CompleteMultipartUpload: parts
    },
    payload = Xml(payloadObject),
    hash = Crypto.createHash('sha256')

  hash.update(payload)

  var sha256 = hash.digest('hex').toLowerCase(),
    stream = new Stream.Readable()

  stream._read = function() {}
  stream.push(payload)
  stream.push(null)

  signV4(requestParams, sha256, params.accessKey, params.secretKey)

  var request = transport.request(requestParams, (response) => {
    if (response.statusCode !== 200) {
      return parseError(response, cb)
    }
    cb()
  })
  stream.pipe(request)
}
