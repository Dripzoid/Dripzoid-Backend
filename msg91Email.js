import axios from "axios";

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY; // from dashboard
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID; // email template id

export async function sendCertificateEmail({
  to,
  internName,
  role,
  certificateImageUrl,
  certificateDownloadUrl,
  verificationUrl,
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
          VERIFY_URL: verificationUrl,
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
