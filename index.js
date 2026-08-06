const express = require("express");
const cors = require("cors")
require("dotenv").config();

const businessRoutes = require("./src/routes/business.routes");
const materialRoutes = require("./src/routes/material.routes");
const salesRoutes = require("./src/routes/sales.routes");

const app = express();
app.use(express.json());
app.use(cors())

// Auth is enforced per-route by the requireAuth middleware inside each router.
app.use("/api/businesses", businessRoutes);
app.use("/api", materialRoutes);
app.use("/api", salesRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port http://localhost:${port}`);
});
