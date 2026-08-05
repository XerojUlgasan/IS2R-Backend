const express = require("express");
const businessController = require("../controllers/business.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every business route requires a valid authenticated user.
router.use(requireAuth);

// Wire HTTP methods to their controller handlers. No logic lives here.
router.get("/", businessController.listBusinesses);
router.post("/", businessController.createBusiness);

module.exports = router;
