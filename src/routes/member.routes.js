const express = require("express");
const memberController = require("../controllers/member.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every member route requires a valid authenticated user.
router.use(requireAuth);

// All member routes are business-scoped. :memberId is the business_members.id.
router.get("/businesses/:businessId/members", memberController.listMembers);
router.post("/businesses/:businessId/members/invite", memberController.inviteMember);
router.patch("/businesses/:businessId/members/:memberId/permissions", memberController.updatePermissions);
router.patch("/businesses/:businessId/members/:memberId/shareholder-cut", memberController.updateShareholderCut);
router.delete("/businesses/:businessId/members/:memberId", memberController.removeMember);

module.exports = router;
