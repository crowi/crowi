// crowi-fileupload-aws

module.exports = function(crowi) {
  'use strict'

  const aws = require('aws-sdk')
  const fs = require('fs')
  const path = require('path')
  const debug = require('debug')('crowi:lib:fileUploaderAws')
  const lib = {}
  const getAwsConfig = function() {
    const config = crowi.getConfig()
    return {
      accessKeyId: config.crowi['upload:aws:accessKeyId'],
      secretAccessKey: config.crowi['upload:aws:secretAccessKey'],
      region: config.crowi['upload:aws:region'],
      bucket: config.crowi['upload:aws:bucket'],
    }
  }

  function S3Factory() {
    const awsConfig = getAwsConfig()
    const Config = crowi.model('Config')
    const config = crowi.getConfig()

    if (!Config.isUploadable(config)) {
      throw new Error('AWS is not configured.')
    }

    aws.config.update({
      accessKeyId: awsConfig.accessKeyId,
      secretAccessKey: awsConfig.secretAccessKey,
      region: awsConfig.region,
    })

    return new aws.S3()
  }

  lib.deleteFile = function(fileId, filePath) {
    const s3 = S3Factory()
    const awsConfig = getAwsConfig()

    const params = {
      Bucket: awsConfig.bucket,
      Key: filePath,
    }

    return new Promise((resolve, reject) => {
      s3.deleteObject(params, (err, data) => {
        if (err) {
          debug('Failed to delete object from s3', err)
          return reject(err)
        }

        // asynclonousely delete cache
        lib.clearCache(fileId)

        resolve(data)
      })
    })
  }

  lib.uploadFile = function(filePath, contentType, fileStream, options) {
    const s3 = S3Factory()
    const awsConfig = getAwsConfig()

    const params = {
      Bucket: awsConfig.bucket,
      ContentType: contentType,
      Key: filePath,
      Body: fileStream,
      ACL: 'public-read',
    }

    return new Promise(function(resolve, reject) {
      s3.putObject(params, function(err, data) {
        if (err) {
          return reject(err)
        }

        return resolve(data)
      })
    })
  }

  lib.generateUrl = function(filePath) {
    const awsConfig = getAwsConfig()
    const url = 'https://' + awsConfig.bucket + '.s3.amazonaws.com/' + filePath

    return url
  }

  lib.findDeliveryFile = function(fileId, filePath) {
    const cacheFile = lib.createCacheFileName(fileId)

    return new Promise((resolve, reject) => {
      debug('find delivery file', cacheFile)
      if (!lib.shouldUpdateCacheFile(cacheFile)) {
        return resolve(cacheFile)
      }

      const loader = require('https')

      const fileStream = fs.createWriteStream(cacheFile)
      const fileUrl = lib.generateUrl(filePath)
      debug('Load attachement file into local cache file', fileUrl, cacheFile)
      loader.get(fileUrl, function(response) {
        response.pipe(fileStream, { end: false })
        response.on('end', () => {
          fileStream.end()
          resolve(cacheFile)
        })
      })
    })
  }

  lib.clearCache = function(fileId) {
    const cacheFile = lib.createCacheFileName(fileId)

    new Promise((resolve, reject) => {
      fs.unlink(cacheFile, err => {
        if (err) {
          debug('Failed to delete cache file', err)
          // through
        }

        resolve()
      })
    })
      .then(data => {
        // success
      })
      .catch(err => {
        debug('Failed to delete cache file (file may not exists).', err)
        // through
      })
  }

  // private
  lib.createCacheFileName = function(fileId) {
    return path.join(crowi.cacheDir, `attachment-${fileId}`)
  }

  // private
  lib.shouldUpdateCacheFile = function(filePath) {
    try {
      const stats = fs.statSync(filePath)

      if (!stats.isFile()) {
        debug('Cache file not found or the file is not a regular file.')
        return true
      }

      if (stats.size <= 0) {
        debug('Cache file found but the size is 0')
        return true
      }
    } catch (e) {
      // no such file or directory
      debug('No cache', e.message)
      return true
    }

    return false
  }

  return lib
}
