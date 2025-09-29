// shiprocket.js
import axios from "axios";

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
const WAREHOUSE_PINCODE = process.env.WAREHOUSE_PINCODE || "533450";
const API_BASE = "https://apiv2.shiprocket.in/v1/external";

let cachedToken = null;
let tokenExpiry = null;

/**
 * Authenticate and get Shiprocket token (cached for ~23h).
 */
async function getToken() {
  if (cachedToken && tokenExpiry && new Date() < tokenExpiry) return cachedToken;

  if (!SHIPROCKET_EMAIL || !SHIPROCKET_PASSWORD) {
    throw new Error("Shiprocket credentials not set in environment variables");
  }

  const res = await axios.post(
    `${API_BASE}/auth/login`,
    { email: SHIPROCKET_EMAIL, password: SHIPROCKET_PASSWORD },
    { headers: { "Content-Type": "application/json" }, timeout: 10000 }
  );

  const token = res?.data?.token;
  if (!token) throw new Error("Auth succeeded but token missing in response");

  cachedToken = token;
  tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000); // 23h
  return cachedToken;
}

/**
 * Check courier serviceability.
 *
 * Required: pickup_postcode, delivery_postcode, cod, weight
 */
async function checkServiceability(destPincode, opts = {}) {
  // Ensure pincodes are integers
  const pickup_postcode = parseInt(WAREHOUSE_PINCODE, 10);
  const delivery_postcode = parseInt(destPincode, 10);

  if (!delivery_postcode || isNaN(delivery_postcode)) {
    throw new Error("destination pincode required and must be a valid integer");
  }

  // Normalize params
  const order_id = opts.order_id ?? null;

  // cod: must be 0 or 1 integer
  const cod =
    opts.cod === undefined
      ? 0
      : opts.cod === true ||
        String(opts.cod) === "1" ||
        String(opts.cod).toLowerCase() === "true"
      ? 1
      : 0;

  // weight: must be number (float), default 1.0
  const weight =
    opts.weight === undefined || opts.weight === "" ? 1.0 : parseFloat(opts.weight);

  if (!order_id && (weight <= 0 || isNaN(weight))) {
    throw new Error("Valid weight is required when order_id is not provided");
  }

  const token = await getToken();

  // Build params
  let params;
  if (order_id) {
    params = { order_id, pickup_postcode, delivery_postcode };
  } else {
    params = {
      pickup_postcode,
      delivery_postcode,
      cod,
      weight,
    };
    if (opts.length) params.length = parseInt(opts.length, 10);
    if (opts.breadth) params.breadth = parseInt(opts.breadth, 10);
    if (opts.height) params.height = parseInt(opts.height, 10);
    if (opts.declared_value)
      params.declared_value = parseInt(opts.declared_value, 10);
    if (opts.mode) params.mode = opts.mode;
    if (opts.is_return !== undefined)
      params.is_return = Number(opts.is_return) ? 1 : 0;
    if (opts.qc_check !== undefined)
      params.qc_check = Number(opts.qc_check) ? 1 : 0;
  }

  try {
    const res = await axios.get(`${API_BASE}/courier/serviceability/`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      params,
      timeout: 15000,
    });

    if (process.env.DEBUG_SHIPROCKET === "1") {
      console.debug(
        "Shiprocket raw response:",
        JSON.stringify(res.data, null, 2)
      );
    }

    // Response parsing: couriers can come in different shapes
    let couriers = [];
    if (Array.isArray(res.data?.data)) {
      couriers = res.data.data;
    } else if (Array.isArray(res.data?.data?.available_couriers)) {
      couriers = res.data.data.available_couriers;
    } else if (Array.isArray(res.data?.available_couriers)) {
      couriers = res.data.available_couriers;
    } else if (Array.isArray(res.data)) {
      couriers = res.data;
    }

    return couriers.map((c) => ({
      courier_id: c.courier_id ?? c.id ?? null,
      courier_name: c.courier_name ?? c.name ?? null,
      rate: c.rate ?? c.shipping_charges ?? c.amount ?? null,
      cod: c.cod ?? cod,
      etd: c.etd ?? c.estimated_delivery ?? c.transit_time ?? null,
      raw: c,
    }));
  } catch (err) {
    const remote = err.response?.data || err.message;
    console.error("Shiprocket Serviceability Error:", remote);
    throw new Error(
      "Failed to check serviceability: " + (remote?.message || remote)
    );
  }
}

export { getToken, checkServiceability };
export default { getToken, checkServiceability };
