import express from "express";
import axios from "axios";
import authMiddleware from "./authAdmin.js";

const router = express.Router();

const MSG91_AUTH_KEY = process.env.MSG91_AUTHKEY;
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;

/* =========================================================
   Helper: Send Email via MSG91
   ========================================================= */
async function sendCertificateEmail({
  to,
  internName,
  role,
  certificateImageUrl,
  certificateDownloadUrl,
}) {
  try {
    const response = await axios.post(
      "https://control.msg91.com/api/v5/email/send",
      {
        to: [{ email: to, name: internName }],
        from: {
          email: "noreply@dripzoid.com",
          name: "Dripzoid",
        },
        template_id: MSG91_TEMPLATE_ID,
        variables: {
          INTERN_NAME: internName,
          ROLE: role,
          PREVIEW_URL: certificateImageUrl,
          DOWNLOAD_URL: certificateDownloadUrl,
        },
      },
      {
        headers: {
          authkey: MSG91_AUTH_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("MSG91 Email Error:", error.response?.data || error.message);
    throw error;
  }
}

/* =========================================================
   POST /api/email/send-certificate
   Triggered from Admin Dashboard button
   ========================================================= */
router.post("/send-certificate", authMiddleware, async (req, res) => {
  try {
    const {
      to,
      internName,
      role,
      certificateImageUrl,
      certificateDownloadUrl,
    } = req.body;

    if (!to || !internName || !certificateImageUrl) {
      return res.status(400).json({
        message: "Missing required fields (to, internName, certificateImageUrl)",
      });
    }

    await sendCertificateEmail({
      to,
      internName,
      role,
      certificateImageUrl,
      certificateDownloadUrl,
    });

    res.json({
      success: true,
      message: "Certificate email sent successfully",
    });
  } catch (err) {
    console.error("Email Route Error:", err);
    res.status(500).json({ message: "Failed to send certificate email" });
  }
});

export default router;
