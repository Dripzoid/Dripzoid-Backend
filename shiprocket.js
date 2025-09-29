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
 * Helper: compute volumetric weight and chargeable/applicable weight
 * - volumetric divisor default 5000 (cm -> kg) (Aramex uses 6000)
 * - minimum chargeable weight fallback is 0.5kg
 */
function computeWeights({ weight = 1.0, length, breadth, height, volumetric_divisor = 5000 }) {
  const actualWeight = parseFloat(weight) || 0;
  let volumetricWeight = 0;

  if (length && breadth && height) {
    const l = parseFloat(length) || 0;
    const b = parseFloat(breadth) || 0;
    const h = parseFloat(height) || 0;
    if (l > 0 && b > 0 && h > 0) {
      volumetricWeight = (l * b * h) / volumetric_divisor; // in kg
    }
  }

  const minimum = 0.5;
  const chargeable = Math.max(actualWeight || 0, volumetricWeight || 0, minimum);

  return {
    actualWeight,
    volumetricWeight: Number(volumetricWeight.toFixed(3)),
    applicableWeight: Number(chargeable.toFixed(3)),
  };
}

/**
 * Build full payload like a Shipping Rate Calculator form would send.
 * Accepts many of the calculator fields (names matched to UI expectations):
 * {
 *   pickup_postcode, delivery_postcode, weight, length, breadth, height,
 *   cod (boolean or 0/1), payment_mode ("Prepaid"|"COD"), shipment_value,
 *   is_dangerous, mode ("Air"|"Surface"), shipment_type ("Domestic"|"International"),
 *   volumetric_divisor (5000 or 6000), order_id, qc_check, is_return
 * }
 */
function buildFullPayload(opts = {}) {
  const pickup_postcode = parseInt(opts.pickup_postcode || WAREHOUSE_PINCODE, 10);
  const delivery_postcode = parseInt(opts.delivery_postcode || opts.destPincode || 0, 10);

  const cod = opts.cod === undefined
    ? 0
    : opts.cod === true || String(opts.cod) === "1" || String(opts.cod).toLowerCase() === "true"
    ? 1
    : 0;

  const weight = (opts.weight === undefined || opts.weight === "") ? 1.0 : parseFloat(opts.weight);

  const length = opts.length ? parseFloat(opts.length) : undefined;
  const breadth = opts.breadth ? parseFloat(opts.breadth) : undefined;
  const height = opts.height ? parseFloat(opts.height) : undefined;

  const volumetric_divisor = opts.volumetric_divisor || (opts.aramex ? 6000 : 5000);

  const { volumetricWeight, applicableWeight, actualWeight } = computeWeights({
    weight, length, breadth, height, volumetric_divisor
  });

  const payload = {
    // required
    pickup_postcode,
    delivery_postcode,

    // weights
    weight: actualWeight,
    volumetric_weight: volumetricWeight,
    chargeable_weight: applicableWeight,

    // parcel dims (optional)
    length: length || undefined,
    breadth: breadth || undefined,
    height: height || undefined,

    // money & flags
    cod,
    payment_mode: opts.payment_mode || (cod ? "COD" : "Prepaid"),
    declared_value: opts.shipment_value ? parseFloat(opts.shipment_value) : undefined,
    is_dangerous: opts.is_dangerous ? 1 : 0,

    // routing / preference
    mode: opts.mode || undefined, // "Air" or "Surface"
    shipment_type: opts.shipment_type || opts.type || "domestic",

    // optional merchant fields
    order_id: opts.order_id || undefined,
    is_return: opts.is_return !== undefined ? Number(opts.is_return) : undefined,
    qc_check: opts.qc_check !== undefined ? Number(opts.qc_check) : undefined,

    // meta
    volumetric_divisor,
  };

  // remove undefined values (clean payload)
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  return payload;
}

/**
 * calculateRates: send the FULL payload to Shiprocket's serviceability endpoint
 * (useful when you want rate breakdowns just like the Shipping Rate Calculator UI).
 * Returns: array of couriers with normalized fields + meta (chargeable/applicable weight etc)
 */
async function calculateRates(opts = {}) {
  if (!opts.delivery_postcode && !opts.destPincode && !opts.delivery_pincode) {
    throw new Error("delivery_postcode is required");
  }

  const token = await getToken();
  const payload = buildFullPayload(opts);

  try {
    // Use POST to send a full payload (some integrations accept GET with params;
    // POST is safer when sending richer JSON payloads).
    const res = await axios.post(`${API_BASE}/courier/serviceability/`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });

    if (process.env.DEBUG_SHIPROCKET === "1") {
      console.debug("Shiprocket full-rate raw response:", JSON.stringify(res.data, null, 2));
      console.debug("Payload sent:", JSON.stringify(payload, null, 2));
    }

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
      rate: c.rate ?? c.shipping_charges ?? c.amount ?? c.charge ?? null,
      cod: c.cod ?? payload.cod ?? 0,
      etd: c.etd ?? c.estimated_delivery ?? c.transit_time ?? null,
      chargeable_weight: payload.chargeable_weight ?? payload.chargeable_weight,
      volumetric_weight: payload.volumetric_weight ?? undefined,
      applicable_weight: payload.chargeable_weight ?? undefined,
      raw: c,
    }));
  } catch (err) {
    const remote = err.response?.data || err.message;
    console.error("Shiprocket calculateRates Error:", remote);
    throw new Error("Failed to calculate rates: " + (remote?.message || remote));
  }
}

/**
 * Backwards-compatible checkServiceability: if `opts.full_payload` is truthy it will
 * call calculateRates (sending the full payload) otherwise it will behave like earlier
 * lightweight GET-based serviceability check.
 */
async function checkServiceability(destPincode, opts = {}) {
  if (opts.full_payload) {
    // move destPincode into opts for convenience
    opts.delivery_postcode = opts.delivery_postcode || destPincode;
    return await calculateRates(opts);
  }

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
    if (opts.declared_value) params.declared_value = parseInt(opts.declared_value, 10);
    if (opts.mode) params.mode = opts.mode;
    if (opts.is_return !== undefined) params.is_return = Number(opts.is_return) ? 1 : 0;
    if (opts.qc_check !== undefined) params.qc_check = Number(opts.qc_check) ? 1 : 0;
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

export { getToken, checkServiceability, calculateRates, buildFullPayload };
export default { getToken, checkServiceability, calculateRates, buildFullPayload };
