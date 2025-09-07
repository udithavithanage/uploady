"use strict";

const fs = require("fs").promises;
const path = require("path");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const mime = require("mime-types");
const sharp = require("sharp");

class EasyFileServer {
  /**
   * @param {object} options
   * @param {string} options.storageDir - Folder to save files
   * @param {number} options.maxFileSize - Max size per file in bytes
   * @param {string[]} options.allowedMimeTypes - Array of allowed MIME types
   * @param {boolean} options.organizeByDate - Create subfolders by date
   * @param {boolean} options.autoThumbnail - Generate image thumbnails
   * @param {object} options.secureUrls - { enabled: boolean, expires: seconds, secret: string }
   */
  constructor(options = {}) {
    this.storageDir = path.resolve(
      options.storageDir || path.join(process.cwd(), "uploads")
    );
    this.maxFileSize = Number(options.maxFileSize) || 2 * 1024 * 1024 * 1024; // 2GB
    this.allowedMimeTypes = Array.isArray(options.allowedMimeTypes)
      ? options.allowedMimeTypes
      : null;
    this.organizeByDate = !!options.organizeByDate;
    this.autoThumbnail = !!options.autoThumbnail;
    this.secureUrls = {
      enabled: !!options.secureUrls?.enabled,
      expires: Number(options.secureUrls?.expires) || 600,
      secret:
        options.secureUrls?.secret || crypto.randomBytes(32).toString("hex"),
    };

    // Validate options
    if (!Number.isInteger(this.maxFileSize) || this.maxFileSize <= 0) {
      throw new Error("maxFileSize must be a positive integer");
    }
    if (
      this.secureUrls.enabled &&
      (!Number.isInteger(this.secureUrls.expires) ||
        this.secureUrls.expires <= 0)
    ) {
      throw new Error("secureUrls.expires must be a positive integer");
    }
    if (this.secureUrls.enabled && !this.secureUrls.secret) {
      throw new Error(
        "secureUrls.secret must be provided when secureUrls.enabled is true"
      );
    }

    // Initialize storage directory
    this._initializeStorage();

    // In-memory metadata storage (replace with DB in production)
    this.metadata = new Map();

    // Event hooks
    this.hooks = {
      onUploadStart: () => {},
      onUploadComplete: () => {},
      onFileDelete: () => {},
    };
  }

  /**
   * Initialize storage directory
   * @private
   */
  async _initializeStorage() {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      console.log(`Storage directory initialized: ${this.storageDir}`);
    } catch (err) {
      throw new Error(`Failed to create storage directory: ${err.message}`);
    }
  }

  /**
   * Stop the server and cleanup resources
   */
  destroy() {
    this.metadata.clear();
    console.log("EasyFileServer destroyed and resources cleaned up");
  }

  /**
   * Register hooks
   * @param {string} event - Event name
   * @param {function} fn - Callback function
   */
  on(event, fn) {
    if (this.hooks.hasOwnProperty(event)) {
      this.hooks[event] = fn;
    } else {
      throw new Error(
        `Invalid event: ${event}. Available events: ${Object.keys(
          this.hooks
        ).join(", ")}`
      );
    }
  }

  /**
   * Generate secure URL with JWT
   * @param {string} filename - File name
   * @param {number} customExpires - Custom expiration time in seconds (optional)
   * @returns {string} URL
   */
  generateSecureUrl(filename, customExpires = null) {
    if (!this.secureUrls.enabled) {
      return `/files/${encodeURIComponent(filename)}`;
    }

    const expirationSeconds = customExpires || this.secureUrls.expires;
    const payload = {
      filename,
      exp: Math.floor(Date.now() / 1000) + expirationSeconds,
    };

    const token = jwt.sign(payload, this.secureUrls.secret);

    console.log(
      `Generated secure URL for ${filename}, expires at ${new Date(
        payload.exp * 1000
      ).toISOString()}`
    );

    return `/files/${encodeURIComponent(filename)}?token=${token}`;
  }

  /**
   * Generate secure thumbnail URL
   * @param {string} filename - Original file name
   * @param {number} customExpires - Custom expiration time in seconds (optional)
   * @returns {string|null} Thumbnail URL or null if no thumbnail exists
   */
  generateSecureThumbnailUrl(filename, customExpires = null) {
    const meta = this.metadata.get(filename);
    if (!meta || !meta.thumbnail) {
      return null;
    }

    if (!this.secureUrls.enabled) {
      return `/thumbnails/${encodeURIComponent(filename)}_thumb.jpg`;
    }

    const expirationSeconds = customExpires || this.secureUrls.expires;
    const payload = {
      filename,
      exp: Math.floor(Date.now() / 1000) + expirationSeconds,
    };

    const token = jwt.sign(payload, this.secureUrls.secret);

    return `/thumbnails/${encodeURIComponent(
      filename
    )}_thumb.jpg?token=${token}`;
  }

  /**
   * Validate secure URL token using JWT
   * @param {string} filename - File name
   * @param {string} token - JWT token
   * @returns {boolean} Valid or not
   */
  validateSecureUrl(filename, token) {
    if (!this.secureUrls.enabled) return true;

    if (!token) {
      console.log("Missing token parameter");
      return false;
    }

    try {
      const payload = jwt.verify(token, this.secureUrls.secret);

      console.log(
        `Validating URL: filename=${filename}, token=${token.substring(
          0,
          8
        )}..., expires=${new Date(payload.exp * 1000).toISOString()}`
      );

      if (payload.filename !== filename) {
        console.log(
          `Filename mismatch: expected ${payload.filename}, got ${filename}`
        );
        return false;
      }

      return true;
    } catch (err) {
      console.log(`Token validation failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Get file metadata
   * @param {string} filename - File name
   * @returns {object|null} File metadata or null if not found
   */
  getFileMetadata(filename) {
    const meta = this.metadata.get(filename);
    if (!meta) return null;

    // Return clean metadata without sensitive fields
    const { path, thumbnail, ...cleanMeta } = meta;
    return {
      ...cleanMeta,
      thumbnailUrl: this.generateSecureThumbnailUrl(filename),
    };
  }

  /**
   * Express middleware for file upload
   * @param {string} fieldName - Form field name
   * @param {number} maxCount - Max number of files
   * @returns {function} Middleware
   */
  upload(fieldName = "files", maxCount = 10) {
    if (
      typeof fieldName !== "string" ||
      !Number.isInteger(maxCount) ||
      maxCount <= 0
    ) {
      throw new Error("Invalid fieldName or maxCount");
    }

    const storage = multer.diskStorage({
      destination: async (req, file, cb) => {
        let folder = this.storageDir;
        if (this.organizeByDate) {
          const dateFolder = new Date().toISOString().slice(0, 10);
          folder = path.join(folder, dateFolder);
          try {
            await fs.mkdir(folder, { recursive: true });
          } catch (err) {
            return cb(new Error(`Failed to create directory: ${err.message}`));
          }
        }
        cb(null, folder);
      },
      filename: (req, file, cb) => {
        // Sanitize original filename
        const originalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
        const ext = path.extname(originalName);
        const baseName = path.basename(originalName, ext);
        const filename = `${Date.now()}-${uuidv4()}-${baseName}${ext}`;
        cb(null, filename);
      },
    });

    const uploadMiddleware = multer({
      storage,
      limits: {
        fileSize: this.maxFileSize,
        files: maxCount,
      },
      fileFilter: (req, file, cb) => {
        // Validate MIME type
        if (
          this.allowedMimeTypes &&
          !this.allowedMimeTypes.includes(file.mimetype)
        ) {
          return cb(new Error(`MIME type not allowed: ${file.mimetype}`));
        }

        // Additional security: validate file extension matches MIME type
        const expectedExt = mime.extension(file.mimetype);
        const actualExt = path
          .extname(file.originalname)
          .slice(1)
          .toLowerCase();

        if (expectedExt && expectedExt !== actualExt) {
          console.warn(
            `MIME type mismatch: ${file.mimetype} vs extension .${actualExt}`
          );
        }

        cb(null, true);
      },
    }).array(fieldName, maxCount);

    return async (req, res, next) => {
      try {
        await this.hooks.onUploadStart(req);

        uploadMiddleware(req, res, async (err) => {
          if (err instanceof multer.MulterError) {
            let errorMessage = `Upload error: ${err.message}`;
            if (err.code === "LIMIT_FILE_SIZE") {
              errorMessage = `File too large. Maximum size: ${this.maxFileSize} bytes`;
            } else if (err.code === "LIMIT_FILE_COUNT") {
              errorMessage = `Too many files. Maximum: ${maxCount} files`;
            }
            return res.status(400).json({ error: errorMessage });
          } else if (err) {
            return res.status(400).json({ error: err.message });
          }

          const uploadedFiles = [];
          const errors = [];

          for (const f of req.files || []) {
            try {
              const meta = {
                originalName: f.originalname,
                storedName: f.filename,
                mime: f.mimetype,
                size: f.size,
                path: path.relative(process.cwd(), f.path),
                uploadedAt: new Date().toISOString(),
                url: this.generateSecureUrl(f.filename),
              };

              // Generate thumbnail if image
              if (this.autoThumbnail && f.mimetype.startsWith("image/")) {
                try {
                  const thumbPath = `${f.path}_thumb.jpg`;
                  await sharp(f.path)
                    .resize({ width: 200, height: 200, fit: "inside" })
                    .jpeg({ quality: 80 })
                    .toFile(thumbPath);

                  meta.thumbnail = path.relative(process.cwd(), thumbPath);
                  meta.thumbnailUrl = this.generateSecureThumbnailUrl(
                    f.filename
                  );
                  console.log(`Thumbnail generated: ${meta.thumbnail}`);
                } catch (thumbErr) {
                  console.error(
                    `Thumbnail generation failed for ${f.filename}: ${thumbErr.message}`
                  );
                  // Don't fail the upload if thumbnail generation fails
                }
              }

              this.metadata.set(f.filename, meta);

              // Return clean metadata
              const { path: filePath, thumbnail, ...cleanMeta } = meta;
              uploadedFiles.push(cleanMeta);
            } catch (metaErr) {
              console.error(
                `Failed to process file ${f.filename}: ${metaErr.message}`
              );
              errors.push({
                filename: f.originalname,
                error: metaErr.message,
              });
            }
          }

          try {
            await this.hooks.onUploadComplete(req, uploadedFiles);
          } catch (hookErr) {
            console.error(`onUploadComplete hook failed: ${hookErr.message}`);
          }

          req.uploadedFiles = uploadedFiles;
          if (errors.length > 0) {
            req.uploadErrors = errors;
          }

          next();
        });
      } catch (hookErr) {
        console.error(`onUploadStart hook failed: ${hookErr.message}`);
        res.status(500).json({ error: "Internal server error" });
      }
    };
  }

  /**
   * Serve files with secure URL validation
   * @returns {function} Middleware
   */
  serveFiles() {
    return async (req, res, next) => {
      const filename = decodeURIComponent(path.basename(req.path));
      const { token } = req.query;

      // Validate secure URL
      if (!this.validateSecureUrl(filename, token)) {
        return res.status(403).json({
          error: "Invalid or expired JWT token",
        });
      }

      // Get file metadata
      const meta = this.metadata.get(filename);
      if (!meta) {
        return res.status(404).json({ error: "File metadata not found" });
      }

      const absolutePath = path.join(process.cwd(), meta.path);

      console.log(`Serving file: ${filename} from ${absolutePath}`);

      try {
        // Check if file exists
        await fs.access(absolutePath);

        // Set appropriate headers
        const mimeType =
          meta.mime || mime.lookup(filename) || "application/octet-stream";
        res.setHeader("Content-Type", mimeType);
        res.setHeader("Content-Length", meta.size);
        // res.setHeader("Cache-Control", "private, max-age=3600"); // 1 hour cache
        res.setHeader("X-Content-Type-Options", "nosniff");

        // Send file
        res.sendFile(absolutePath, (err) => {
          if (err) {
            console.error(`Error sending file ${absolutePath}: ${err.message}`);
            if (!res.headersSent) {
              res.status(500).json({ error: "Failed to send file" });
            }
          }
        });
      } catch (err) {
        console.error(`File access error for ${absolutePath}: ${err.message}`);
        res.status(404).json({ error: "File not found" });
      }
    };
  }

  /**
   * Serve thumbnails with secure URL validation
   * @returns {function} Middleware
   */
  serveThumbnails() {
    return async (req, res, next) => {
      const thumbnailFilename = decodeURIComponent(path.basename(req.path));
      const originalFilename = thumbnailFilename.replace("_thumb.jpg", "");
      const { token } = req.query;

      // Validate secure URL using the original filename
      if (!this.validateSecureUrl(originalFilename, token)) {
        return res.status(403).json({
          error: "Invalid or expired JWT token",
        });
      }

      // Get file metadata
      const meta = this.metadata.get(originalFilename);
      if (!meta || !meta.thumbnail) {
        return res.status(404).json({ error: "Thumbnail not found" });
      }

      const absolutePath = path.join(process.cwd(), meta.thumbnail);

      console.log(
        `Serving thumbnail: ${thumbnailFilename} from ${absolutePath}`
      );

      try {
        // Check if thumbnail exists
        await fs.access(absolutePath);

        // Set appropriate headers
        res.setHeader("Content-Type", "image/jpeg");
        // res.setHeader("Cache-Control", "private, max-age=86400"); // 24 hours cache
        res.setHeader("X-Content-Type-Options", "nosniff");

        // Send thumbnail
        res.sendFile(absolutePath, (err) => {
          if (err) {
            console.error(
              `Error sending thumbnail ${absolutePath}: ${err.message}`
            );
            if (!res.headersSent) {
              res.status(500).json({ error: "Failed to send thumbnail" });
            }
          }
        });
      } catch (err) {
        console.error(
          `Thumbnail access error for ${absolutePath}: ${err.message}`
        );
        res.status(404).json({ error: "Thumbnail not found" });
      }
    };
  }

  /**
   * List files metadata
   * @param {object} options - Options for listing
   * @param {number} options.page - Page number (1-based)
   * @param {number} options.limit - Items per page
   * @param {string} options.sortBy - Sort field (uploadedAt, size, originalName)
   * @param {string} options.sortOrder - Sort order (asc, desc)
   * @returns {Promise<object>} Paginated file list with metadata
   */
  async listFiles(options = {}) {
    const {
      page = 1,
      limit = 50,
      sortBy = "uploadedAt",
      sortOrder = "desc",
    } = options;

    // Get all files and clean metadata
    const allFiles = Array.from(this.metadata.values()).map((meta) => {
      const { path, thumbnail, ...cleanMeta } = meta;
      return {
        ...cleanMeta,
        thumbnailUrl: this.generateSecureThumbnailUrl(meta.storedName),
      };
    });

    // Sort files
    allFiles.sort((a, b) => {
      let comparison = 0;
      if (sortBy === "uploadedAt") {
        comparison = new Date(a.uploadedAt) - new Date(b.uploadedAt);
      } else if (sortBy === "size") {
        comparison = a.size - b.size;
      } else if (sortBy === "originalName") {
        comparison = a.originalName.localeCompare(b.originalName);
      }
      return sortOrder === "desc" ? -comparison : comparison;
    });

    // Paginate
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedFiles = allFiles.slice(startIndex, endIndex);

    return {
      files: paginatedFiles,
      pagination: {
        page,
        limit,
        total: allFiles.length,
        pages: Math.ceil(allFiles.length / limit),
        hasNext: endIndex < allFiles.length,
        hasPrev: page > 1,
      },
    };
  }

  /**
   * Delete file and its thumbnail
   * @param {string} filename - File name
   * @returns {Promise<boolean>} Success status
   */
  async deleteFile(filename) {
    const meta = this.metadata.get(filename);
    if (!meta) {
      console.log(`File metadata not found for: ${filename}`);
      return false;
    }

    try {
      // Delete main file
      const mainPath = path.join(process.cwd(), meta.path);
      await fs.unlink(mainPath);
      console.log(`Deleted file: ${mainPath}`);

      // Delete thumbnail if exists
      if (meta.thumbnail) {
        try {
          const thumbPath = path.join(process.cwd(), meta.thumbnail);
          await fs.unlink(thumbPath);
          console.log(`Deleted thumbnail: ${thumbPath}`);
        } catch (thumbErr) {
          console.error(`Failed to delete thumbnail: ${thumbErr.message}`);
          // Continue even if thumbnail deletion fails
        }
      }

      // Clean up metadata
      this.metadata.delete(filename);

      // Call hook
      try {
        await this.hooks.onFileDelete(filename, meta);
      } catch (hookErr) {
        console.error(`onFileDelete hook failed: ${hookErr.message}`);
      }

      console.log(`Successfully deleted file and metadata: ${filename}`);
      return true;
    } catch (err) {
      console.error(`Failed to delete file ${filename}: ${err.message}`);
      return false;
    }
  }

  /**
   * Get server statistics
   * @returns {object} Server statistics
   */
  getStats() {
    const files = Array.from(this.metadata.values());
    const totalSize = files.reduce((sum, meta) => sum + meta.size, 0);
    const mimeTypes = {};

    files.forEach((meta) => {
      mimeTypes[meta.mime] = (mimeTypes[meta.mime] || 0) + 1;
    });

    return {
      totalFiles: files.length,
      totalSize,
      totalSizeMB: Math.round((totalSize / (1024 * 1024)) * 100) / 100,
      secureUrlsEnabled: this.secureUrls.enabled,
      storageDir: this.storageDir,
    };
  }
}

module.exports = EasyFileServer;
