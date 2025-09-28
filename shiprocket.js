// shiprocket.js
import axios from "axios";

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
const WAREHOUSE_PINCODE = process.env.WAREHOUSE_PINCODE || "533450"; // change if needed
const API_BASE = "https://apiv2.shiprocket.in/v1/external";

let cachedToken = null;
let tokenExpiry = null;

/**
 * Get or refresh Shiprocket token (cached in-memory)
 */
async function getToken() {
  if (cachedToken && tokenExpiry && new Date() < tokenExpiry) {
    return cachedToken;
  }

  if (!SHIPROCKET_EMAIL || !SHIPROCKET_PASSWORD) {
    throw new Error("Shiprocket credentials not set in environment variables");
  }

  try {
    const res = await axios.post(`${API_BASE}/auth/login`, {
      email: SHIPROCKET_EMAIL,
      password: SHIPROCKET_PASSWORD,
    }, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });

    // expect res.data.token
    const token = res?.data?.token;
    if (!token) {
      throw new Error("Auth succeeded but token missing in response");
    }

    cachedToken = token;
    // Set expiry to 23 hours from now (tokens ~24h)
    tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000);
    return cachedToken;
  } catch (err) {
    // Surface Shiprocket response when available
    const remote = err.response?.data || err.message;
    console.error("Shiprocket Auth Error:", remote);
    // if IP blocked you'll often see 403 or an error message here
    throw new Error("Failed to authenticate with Shiprocket: " + (remote?.message || remote));
  }
}

/**
 * checkServiceability
 * - destPincode: string or number (delivery_postcode)
 * - opts: { cod, weight, length, breadth, height, declared_value, mode, is_return, qc_check, order_id }
 *
 * NOTE (docs): either order_id OR (cod + weight) is required.
 *
 * Returns: normalized array of couriers (may be empty).
 */
async function checkServiceability(destPincode, opts = {}) {
  // sanitize/normalize params
  const pickup_postcode = String(WAREHOUSE_PINCODE).trim();
  const delivery_postcode = String(destPincode || "").trim();

  if (!delivery_postcode) throw new Error("destination pincode required");

  // accept both booleans and '1'/'0' strings
  const order_id = opts.order_id ?? null;
  const cod = opts.cod === undefined ? undefined : (opts.cod === true || String(opts.cod) === "1" || String(opts.cod).toLowerCase() === "true" ? 1 : 0);
  const weight = opts.weight === undefined ? undefined : String(opts.weight);
  const length = opts.length ?? opts.l ?? 0;
  const breadth = opts.breadth ?? opts.width ?? opts.w ?? 0;
  const height = opts.height ?? opts.h ?? 0;
  const declared_value = opts.declared_value ?? opts.declaredValue ?? 0;
  const mode = opts.mode ?? null; // "Air" or "Surface"
  const is_return = opts.is_return === undefined ? 0 : (Number(opts.is_return) ? 1 : 0);
  const qc_check = opts.qc_check === undefined ? 0 : (Number(opts.qc_check) ? 1 : 0);

  // Validate conditional requirement (per docs)
  if (!order_id && (cod === undefined || weight === undefined || weight === "")) {
    throw new Error("Either order_id OR both cod and weight must be provided");
  }

  // set sensible defaults if values missing (weight & dims)
  const finalWeight = weight !== undefined && weight !== "" ? weight : "1"; // kg as string per docs
  const finalLength = length || 10;
  const finalBreadth = breadth || 10;
  const finalHeight = height || 10;

  const token = await getToken();

  try {
    const res = await axios.get(`${API_BASE}/courier/serviceability/`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      params: {
        pickup_postcode,
        delivery_postcode,
        // one of order_id OR (cod && weight) is required
        ...(order_id ? { order_id } : { cod, weight: finalWeight }),
        length: finalLength,
        breadth: finalBreadth,
        height: finalHeight,
        declared_value: declared_value || undefined,
        mode: mode || undefined,
        is_return,
        qc_check,
      },
      timeout: 15000,
    });

    // Shiprocket response shapes vary; log raw if DEBUG
    if (process.env.DEBUG_SHIPROCKET === "1") {
      console.debug("Shiprocket raw serviceability:", JSON.stringify(res.data, null, 2));
    }

    // According to docs, available couriers sit in res.data.data.available_couriers
    const available = res.data?.data?.available_couriers ?? res.data?.data ?? res.data ?? null;

    // Normalize to an array of courier objects
    let arr = [];
    if (Array.isArray(available)) {
      arr = available;
    } else if (available && typeof available === "object") {
      // some accounts return object that contains nested array; try common keys:
      arr = available.available_couriers ?? available.couriers ?? available.data ?? [];
      if (!Array.isArray(arr)) arr = [];
    } else {
      arr = [];
    }

    // Build a normalized result array for our API consumers
    const normalized = arr.map((c) => {
      // c can have many keys; pick the common ones used by UI
      return {
        courier_id: c.courier_id ?? c.id ?? c.courier ?? null,
        courier_name: c.courier_name ?? c.name ?? c.courier ?? null,
        rate: c.rate ?? c.shipping_charges ?? c.shipping_charge ?? c.amount ?? null,
        cod: c.cod ?? cod ?? null,
        etd: c.etd ?? c.estimated_delivery ?? c.transit_time ?? c.delivery_time ?? null,
        raw: c, // keep raw for inspection
      };
    });

    return normalized;
  } catch (err) {
    const remote = err.response?.data || err.message;
    console.error("Shiprocket Serviceability Error:", remote);
    // propagate a helpful message but do not leak secrets
    const code = err.response?.status;
    if (code === 401 || code === 403) {
      throw new Error("Shiprocket authorization/permission error: " + (remote?.message || remote));
    }
    throw new Error("Failed to check serviceability: " + (remote?.message || remote));
  }
}

export { getToken, checkServiceability };
export default { getToken, checkServiceability };
