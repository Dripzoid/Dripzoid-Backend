// shiprocket.js
import axios from "axios";

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
const WAREHOUSE_PINCODE = process.env.WAREHOUSE_PINCODE || "533450";
const API_BASE = "https://apiv2.shiprocket.in/v1/external";

let cachedToken = null;
let tokenExpiry = null;

async function getToken() {
  if (cachedToken && tokenExpiry && new Date() < tokenExpiry) return cachedToken;

  if (!SHIPROCKET_EMAIL || !SHIPROCKET_PASSWORD)
    throw new Error("Shiprocket credentials not set in environment variables");

  const res = await axios.post(
    `${API_BASE}/auth/login`,
    { email: SHIPROCKET_EMAIL, password: SHIPROCKET_PASSWORD },
    { headers: { "Content-Type": "application/json" }, timeout: 10000 }
  );

  const token = res?.data?.token;
  if (!token) throw new Error("Auth succeeded but token missing in response");

  cachedToken = token;
  tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000); // 23h expiry
  return cachedToken;
}

async function checkServiceability(destPincode, opts = {}) {
  // Convert pickup & delivery postcodes to integers
  const pickup_postcode = parseInt(WAREHOUSE_PINCODE, 10);
  const delivery_postcode = parseInt(destPincode, 10);

  if (!delivery_postcode || isNaN(delivery_postcode)) {
    throw new Error("destination pincode required and must be a valid integer");
  }

  // Normalize and default parameters
  const order_id = opts.order_id ?? null;
  const cod =
    opts.cod === undefined
      ? 0
      : opts.cod === true || String(opts.cod) === "1" || String(opts.cod).toLowerCase() === "true"
      ? 1
      : 0;
  const weight = opts.weight === undefined || opts.weight === "" ? "1" : String(opts.weight);
  const length = opts.length ?? opts.l ?? 10;
  const breadth = opts.breadth ?? opts.width ?? opts.w ?? 10;
  const height = opts.height ?? opts.h ?? 10;
  const declared_value = opts.declared_value ?? opts.declaredValue ?? 100;
  const mode = opts.mode ?? null;
  const is_return = opts.is_return === undefined ? 0 : (Number(opts.is_return) ? 1 : 0);
  const qc_check = opts.qc_check === undefined ? 0 : (Number(opts.qc_check) ? 1 : 0);

  // Validate conditional requirement after defaults
  if (!order_id && (cod === undefined || !weight || weight === "")) {
    throw new Error("Either order_id OR both cod and weight must be provided");
  }

  const token = await getToken();

  try {
    const res = await axios.get(`${API_BASE}/courier/serviceability/`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      params: order_id
        ? { order_id, pickup_postcode, delivery_postcode }
        : {
            pickup_postcode,
            delivery_postcode,
            cod,
            weight,
            length,
            breadth,
            height,
            declared_value,
            mode,
            is_return,
            qc_check,
          },
      timeout: 15000,
    });

    const available = res.data?.data?.available_couriers ?? res.data?.data ?? res.data ?? [];
    const arr = Array.isArray(available)
      ? available
      : available.available_couriers ?? available.couriers ?? available.data ?? [];

    return arr.map((c) => ({
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
    throw new Error("Failed to check serviceability: " + (remote?.message || remote));
  }
}

export { getToken, checkServiceability };
export default { getToken, checkServiceability };
