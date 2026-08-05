const express = require("express");
const cors = require("cors")
require("dotenv").config();

const businessRoutes = require("./src/routes/business.routes");

const app = express();
app.use(express.json());
app.use(cors())

// Auth is enforced per-route by the requireAuth middleware inside the router.
app.use("/api/businesses", businessRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port http://localhost:${port}`);
});
