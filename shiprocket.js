// shiprocket.js
import axios from "axios";

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;

const WAREHOUSE_PINCODE = "533450"; // default warehouse pincode

let cachedToken = null;
let tokenExpiry = null;

/**
 * Get or refresh Shiprocket token
 */
async function getToken() {
  if (cachedToken && tokenExpiry && new Date() < tokenExpiry) return cachedToken;

  try {
    const res = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/auth/login",
      { email: SHIPROCKET_EMAIL, password: SHIPROCKET_PASSWORD }
    );

    cachedToken = res.data.token;
    tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000); // 23h expiry

    return cachedToken;
  } catch (err) {
    console.error("Shiprocket Auth Error:", err.response?.data || err.message);
    throw new Error("Failed to authenticate with Shiprocket");
  }
}

/**
 * Check serviceability between warehouse and customer pincode
 */
async function checkServiceability(destPincode, cod = true, weight = 0.5) {
  try {
    const token = await getToken();

    const res = await axios.get(
      "https://apiv2.shiprocket.in/v1/external/courier/serviceability/",
      {
        params: {
          pickup_postcode: WAREHOUSE_PINCODE,
          delivery_postcode: destPincode,
          cod: cod ? 1 : 0,
          weight,
        },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    // Extract only relevant courier info
    return res.data?.data?.map(courier => ({
      courier_name: courier.name,
      estimated_delivery_days: courier.transit_time,
      cod: courier.cod,
      shipping_charges: courier.shipping_charges,
    })) || [];
  } catch (err) {
    console.error(
      "Shiprocket Serviceability Error:",
      err.response?.data || err.message
    );
    throw new Error("Failed to check serviceability");
  }
}

export { getToken, checkServiceability };
