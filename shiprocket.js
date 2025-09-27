// shiprocket.js
import axios from "axios";

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;

let cachedToken = null;
let tokenExpiry = null;

/**
 * Get or refresh Shiprocket token
 */
async function getToken() {
  // Reuse valid token if not expired
  if (cachedToken && tokenExpiry && new Date() < tokenExpiry) {
    return cachedToken;
  }

  try {
    const res = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/auth/login",
      {
        email: SHIPROCKET_EMAIL,
        password: SHIPROCKET_PASSWORD,
      }
    );

    cachedToken = res.data.token;
    // Shiprocket tokens expire after ~24 hours → set expiry to 23h
    tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000);

    return cachedToken;
  } catch (err) {
    console.error("Shiprocket Auth Error:", err.response?.data || err.message);
    throw new Error("Failed to authenticate with Shiprocket");
  }
}

/**
 * Check serviceability between two pincodes
 * @param {string} originPincode - Seller / warehouse pincode
 * @param {string} destPincode - Customer pincode
 * @param {boolean} cod - true if COD check, false if prepaid
 * @param {number} weight - Weight in KG (default 0.5kg)
 */
async function checkServiceability(originPincode, destPincode, cod = true, weight = 0.5) {
  try {
    const token = await getToken();

    const res = await axios.get(
      "https://apiv2.shiprocket.in/v1/external/courier/serviceability/",
      {
        params: {
          pickup_postcode: originPincode,
          delivery_postcode: destPincode,
          cod: cod ? 1 : 0,
          weight,
        },
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return res.data;
  } catch (err) {
    console.error("Shiprocket Serviceability Error:", err.response?.data || err.message);
    throw new Error("Failed to check serviceability");
  }
}

export { getToken, checkServiceability };
