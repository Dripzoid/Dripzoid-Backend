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
  const chargeable = Math.max(actualWeight, volumetricWeight, minimum);

  return {
    actualWeight,
    volumetricWeight: Number(volumetricWeight.toFixed(3)),
    applicableWeight: Number(chargeable.toFixed(3)),
  };
}

/**
 * Build full payload like Shipping Rate Calculator form
 */
function buildFullPayload(opts = {}) {
  const pickup_postcode = parseInt(opts.pickup_postcode || WAREHOUSE_PINCODE, 10);
  const delivery_postcode = parseInt(opts.delivery_postcode || opts.destPincode || 0, 10);

  if (!delivery_postcode) throw new Error("delivery_postcode is required");

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
    pickup_postcode,
    delivery_postcode,
    weight: actualWeight,
    volumetric_weight: volumetricWeight,
    chargeable_weight: applicableWeight,
    length,
    breadth,
    height,
    cod,
    payment_mode: opts.payment_mode || (cod ? "COD" : "Prepaid"),
    declared_value: opts.shipment_value ? parseFloat(opts.shipment_value) : undefined,
    is_dangerous: opts.is_dangerous ? 1 : 0,
    mode: opts.mode || undefined,
    shipment_type: opts.shipment_type
      ? opts.shipment_type.charAt(0).toUpperCase() + opts.shipment_type.slice(1)
      : "Domestic",
    order_id: opts.order_id || undefined,
    is_return: opts.is_return !== undefined ? Number(opts.is_return) : undefined,
    qc_check: opts.qc_check !== undefined ? Number(opts.qc_check) : undefined,
    volumetric_divisor,
  };

  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  return payload;
}

/**
 * Send full payload to Shiprocket and return normalized courier rates
 */
async function calculateRates(opts = {}) {
  const token = await getToken();
  const payload = buildFullPayload(opts);

  try {
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
    if (Array.isArray(res.data?.data?.available_courier_companies)) {
      couriers = res.data.data.available_courier_companies;
    } else if (Array.isArray(res.data?.data?.available_couriers)) {
      couriers = res.data.data.available_couriers;
    } else if (Array.isArray(res.data)) {
      couriers = res.data;
    }

    return couriers.map((c) => ({
      courier_id: c.courier_company_id ?? c.courier_id ?? c.id ?? null,
      courier_name: c.courier_name ?? c.name ?? null,
      rate: c.rate ?? c.shipping_charges ?? c.amount ?? c.freight_charge ?? null,
      cod: c.cod ?? payload.cod ?? 0,
      etd: c.etd ?? c.estimated_delivery ?? c.transit_time ?? null,
      chargeable_weight: payload.chargeable_weight,
      volumetric_weight: payload.volumetric_weight,
      applicable_weight: payload.chargeable_weight,
      raw: c,
    }));
  } catch (err) {
    const remote = err.response?.data || err.message;
    console.error("Shiprocket calculateRates Error:", remote);
    throw new Error("Failed to calculate rates: " + (remote?.message || remote));
  }
}

/**
 * Check serviceability (lightweight GET or full payload POST)
 */
async function checkServiceability(destPincode, opts = {}) {
  if (opts.full_payload) {
    opts.delivery_postcode = opts.delivery_postcode || destPincode;
    return await calculateRates(opts);
  }

  const pickup_postcode = parseInt(WAREHOUSE_PINCODE, 10);
  const delivery_postcode = parseInt(destPincode, 10);

  if (!delivery_postcode || isNaN(delivery_postcode)) {
    throw new Error("destination pincode required and must be a valid integer");
  }

  const cod =
    opts.cod === undefined
      ? 0
      : opts.cod === true || String(opts.cod) === "1" || String(opts.cod).toLowerCase() === "true"
      ? 1
      : 0;

  const weight = opts.weight === undefined || opts.weight === "" ? 1.0 : parseFloat(opts.weight);

  const token = await getToken();

  let params = { pickup_postcode, delivery_postcode, cod, weight };
  if (opts.length) params.length = parseInt(opts.length, 10);
  if (opts.breadth) params.breadth = parseInt(opts.breadth, 10);
  if (opts.height) params.height = parseInt(opts.height, 10);
  if (opts.declared_value) params.declared_value = parseInt(opts.declared_value, 10);
  if (opts.mode) params.mode = opts.mode;
  if (opts.is_return !== undefined) params.is_return = Number(opts.is_return) ? 1 : 0;
  if (opts.qc_check !== undefined) params.qc_check = Number(opts.qc_check) ? 1 : 0;

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
      console.debug("Shiprocket lightweight raw response:", JSON.stringify(res.data, null, 2));
      console.debug("GET params:", JSON.stringify(params, null, 2));
    }

    let couriers = [];
    if (Array.isArray(res.data?.data?.available_courier_companies)) {
      couriers = res.data.data.available_courier_companies;
    } else if (Array.isArray(res.data?.data?.available_couriers)) {
      couriers = res.data.data.available_couriers;
    } else if (Array.isArray(res.data)) {
      couriers = res.data;
    }

    return couriers.map((c) => ({
      courier_id: c.courier_company_id ?? c.courier_id ?? c.id ?? null,
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

export { getToken, checkServiceability, calculateRates, buildFullPayload };
export default { getToken, checkServiceability, calculateRates, buildFullPayload };
