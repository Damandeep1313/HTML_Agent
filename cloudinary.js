/*********************************************************
 * server.js
 *
 * 1) npm install express axios sharp cloudinary dotenv
 * 2) .env with:
 *    CLOUDINARY_CLOUD_NAME=xxx
 *    CLOUDINARY_API_KEY=xxx
 *    CLOUDINARY_API_SECRET=xxx
 *********************************************************/

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const cloudinary = require("cloudinary").v2;

const app = express();
app.use(express.json());

// Configure Cloudinary from .env
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// A helper function that tries to compress an image buffer
// under the target size by lowering quality in small steps.
async function compressImageToUnder(buffer, targetSizeKB = 250) {
  let quality = 90;
  let outputBuffer = buffer;

  // We iterate down in quality steps if needed
  while (quality > 10) {
    const compressed = await sharp(buffer)
      .jpeg({ quality, force: true }) // or .png({quality, force:true}) depending on your format
      .toBuffer();
    const sizeKB = Math.round(compressed.length / 1024);

    if (sizeKB <= targetSizeKB) {
      console.log(`Compression successful at quality=${quality}, size=${sizeKB}KB`);
      return compressed;
    }

    // If still too big, lower quality by 10
    quality -= 10;
  }

  // If we exit the loop, we just return whatever we got at the last iteration
  console.log(`Could not reach < ${targetSizeKB}KB, returning last attempt at quality=${quality}`);
  const finalTry = await sharp(buffer)
    .jpeg({ quality, force: true })
    .toBuffer();
  return finalTry;
}

// The main endpoint
app.post("/compress-upload", async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ error: "Missing 'imageUrl' field" });
    }

    console.log("Fetching image from:", imageUrl);
    // 1) Fetch the image as an array buffer
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const originalBuffer = Buffer.from(response.data);

    console.log("Original image size (KB):", Math.round(originalBuffer.length / 1024));

    // 2) Compress image under 250KB (if possible)
    const compressedBuffer = await compressImageToUnder(originalBuffer, 250);
    console.log("Compressed size (KB):", Math.round(compressedBuffer.length / 1024));

    // 3) Upload to Cloudinary using an upload stream
    //    We wrap this in a promise for convenience.
    const uploadToCloudinary = () => {
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: "compressed-images" }, // optional folder name
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );
        // Pipe the compressed buffer to the upload stream
        uploadStream.end(compressedBuffer);
      });
    };

    const uploadResult = await uploadToCloudinary();

    // 4) Return Cloudinary URL
    console.log("Cloudinary URL:", uploadResult.secure_url);
    return res.status(200).json({
      success: true,
      cloudinaryUrl: uploadResult.secure_url,
      note: "Image compressed & uploaded successfully",
    });
  } catch (err) {
    console.error("Error in /compress-upload:", err);
    return res.status(500).json({ error: "Failed to compress or upload image" });
  }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Image compressor is running at http://localhost:${port}`);
});
