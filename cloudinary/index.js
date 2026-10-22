
require('dotenv').config();

const multer = require('multer');
const { v2: cloudinaryClient } = require('cloudinary');

const isCloudinaryDisabled = process.env.CLOUDINARY_DISABLE === 'true';

let storage = null;

if (!isCloudinaryDisabled) {
  cloudinaryClient.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_KEY,
    api_secret: process.env.CLOUDINARY_SECRET
  });
}

function getStorage() {
  if (storage) return storage;

  if (isCloudinaryDisabled) {
    console.warn('⚠️ Cloudinary is disabled.');
    storage = multer.memoryStorage();
    return storage;
  }

  // Multer互換のカスタムストレージ
  storage = {
    _handleFile(req, file, callback) {
      const uploadStream = cloudinaryClient.uploader.upload_stream(
        {
          folder: 'AccountBook_Profile',
          resource_type: 'image',
          allowed_formats: ['jpeg', 'png', 'jpg']
        },
        (error, result) => {
          if (error) return callback(error);
          if (!result) {
            return callback(new Error('Cloudinary returned no upload result'));
          }

          callback(null, {
            path: result.secure_url,
            filename: result.public_id,
            size: result.bytes
          });
        }
      );

      file.stream.on('error', error => {
        uploadStream.destroy(error);
      });

      file.stream.pipe(uploadStream);
    },

    _removeFile(req, file, callback) {
      if (!file.filename) return callback(null);

      cloudinaryClient.uploader.destroy(
        file.filename,
        { resource_type: 'image' },
        error => callback(error || null)
      );
    }
  };

  return storage;
}

module.exports = {
  cloudinary: isCloudinaryDisabled ? null : cloudinaryClient,
  getStorage,
  get cloudinaryEnabled() {
    return !isCloudinaryDisabled;
  }
};
