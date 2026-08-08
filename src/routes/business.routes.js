const express = require("express");
const multer = require("multer");
const businessController = require("../controllers/business.controller");
const { requireAuth } = require("../middleware/auth");
const { LOGO_MAX_BYTES, LOGO_MIME_EXT } = require("../services/business.service");

const router = express.Router();

// In-memory upload for the logo: single file, image-only, 2MB cap.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (LOGO_MIME_EXT[file.mimetype]) {
      return cb(null, true);
    }
    cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "logo"));
  },
});

// Translates multer errors (too large, wrong type) into clean 400 responses.
function handleLogoUpload(req, res, next) {
  logoUpload.single("logo")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "Logo must be 2MB or smaller" });
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ error: "Logo must be an image file sent as 'logo'" });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return next(err);
    }
    return next();
  });
}

// Every business route requires a valid authenticated user.
router.use(requireAuth);

// Wire HTTP methods to their controller handlers. No logic lives here.
router.get("/", businessController.listBusinesses);
router.post("/", businessController.createBusiness);
router.post("/:businessId/accept", businessController.acceptInvite);

// Business settings (owner only; enforced in the service layer).
router.get("/:businessId/settings", businessController.getSettings);
router.patch("/:businessId/settings", businessController.updateSettings);
router.post("/:businessId/settings/logo", handleLogoUpload, businessController.uploadLogo);

module.exports = router;
