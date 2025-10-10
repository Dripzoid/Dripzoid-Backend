// shiprocket.js
import axios from "axios";

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
const WAREHOUSE_PINCODE = process.env.WAREHOUSE_PINCODE || "533450";
const API_BASE = "https://apiv2.shiprocket.in/v1/external";

let cachedToken = null;
let tokenExpiry = null;

/**
 * Authenticate and get Shiprocket token (cached ~23h)
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
 * Compute weights (actual, volumetric, chargeable)
 */
function computeWeights({ weight = 1.0, length, breadth, height, volumetric_divisor = 5000 }) {
  const actualWeight = parseFloat(weight) || 0;
  let volumetricWeight = 0;

  if (length && breadth && height) {
    const l = parseFloat(length) || 0;
    const b = parseFloat(breadth) || 0;
    const h = parseFloat(height) || 0;
    if (l > 0 && b > 0 && h > 0) {
      volumetricWeight = (l * b * h) / volumetric_divisor;
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
 * Build full payload for rate calculation or order creation
 */
function buildFullPayload(opts = {}) {
  const pickup_postcode = parseInt(opts.pickup_postcode || WAREHOUSE_PINCODE, 10);
  const delivery_postcode = parseInt(opts.delivery_postcode || opts.destPincode || 0, 10);

  if (!delivery_postcode) throw new Error("delivery_postcode is required");

  const cod =
    opts.cod === undefined
      ? 0
      : opts.cod === true || String(opts.cod) === "1" || String(opts.cod).toLowerCase() === "true"
      ? 1
      : 0;

  const weight = opts.weight === undefined || opts.weight === "" ? 1.0 : parseFloat(opts.weight);
  const length = opts.length ? parseFloat(opts.length) : undefined;
  const breadth = opts.breadth ? parseFloat(opts.breadth) : undefined;
  const height = opts.height ? parseFloat(opts.height) : undefined;
  const volumetric_divisor = opts.volumetric_divisor || (opts.aramex ? 6000 : 5000);

  const { volumetricWeight, applicableWeight, actualWeight } = computeWeights({
    weight,
    length,
    breadth,
    height,
    volumetric_divisor,
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
    shipment_type: opts.shipment_type
      ? opts.shipment_type.charAt(0).toUpperCase() + opts.shipment_type.slice(1)
      : "Domestic",
    order_id: opts.order_id || undefined,
    is_return: opts.is_return !== undefined ? Number(opts.is_return) : undefined,
    qc_check: opts.qc_check !== undefined ? Number(opts.qc_check) : undefined,
    order_items: opts.order_items || undefined,
    shipping_customer_name: opts.shipping_customer_name,
    shipping_last_name: opts.shipping_last_name,
    shipping_address: opts.shipping_address,
    shipping_address_2: opts.shipping_address_2,
    shipping_city: opts.shipping_city,
    shipping_state: opts.shipping_state,
    shipping_country: opts.shipping_country,
    shipping_pincode: opts.shipping_pincode,
    shipping_email: opts.shipping_email,
    shipping_phone: opts.shipping_phone,
    billing_customer_name: opts.billing_customer_name,
    billing_last_name: opts.billing_last_name,
    billing_address: opts.billing_address,
    billing_address_2: opts.billing_address_2,
    billing_city: opts.billing_city,
    billing_state: opts.billing_state,
    billing_country: opts.billing_country,
    billing_pincode: opts.billing_pincode,
    billing_email: opts.billing_email,
    billing_phone: opts.billing_phone,
    order_type: opts.order_type || "regular",
    invoice_number: opts.invoice_number || undefined,
    customer_gstin: opts.customer_gstin || undefined,
    shipping_charges: opts.shipping_charges || 0,
    giftwrap_charges: opts.giftwrap_charges || 0,
    transaction_charges: opts.transaction_charges || 0,
    total_discount: opts.total_discount || 0,
    sub_total: opts.sub_total || 0,
    ewaybill_no: opts.ewaybill_no || undefined,
    reseller_name: opts.reseller_name || undefined,
    company_name: opts.company_name || undefined,
    comment: opts.comment || undefined,
    channel_id: opts.channel_id || undefined,
    pickup_location: opts.pickup_location || undefined,
    order_date: opts.order_date || undefined,
  };

  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  return payload;
}

/**
 * Calculate shipping rates
 */
async function calculateRates(opts = {}) {
  const token = await getToken();
  const payload = buildFullPayload(opts);

  try {
    const res = await axios.post(`${API_BASE}/courier/serviceability/`, payload, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 20000,
    });

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
 * Check serviceability
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
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      params,
      timeout: 15000,
    });

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

/**
 * Create an order in Shiprocket
 */
async function createOrder(orderPayload) {
  const token = await getToken();
  try {
    const res = await axios.post(`${API_BASE}/orders/create/adhoc`, orderPayload, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 20000,
    });
    return res.data;
  } catch (err) {
    const remote = err.response?.data || err.message;
    console.error("Shiprocket createOrder Error:", remote);
    throw new Error("Failed to create order: " + (remote?.message || remote));
  }
}

/**
 * Update an order in Shiprocket
 */
async function updateOrder(orderPayload) {
  const token = await getToken();
  try {
    const res = await axios.post(`${API_BASE}/orders/update/adhoc`, orderPayload, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 20000,
    });
    return res.data;
  } catch (err) {
    const remote = err.response?.data || err.message;
    console.error("Shiprocket updateOrder Error:", remote);
    throw new Error("Failed to update order: " + (remote?.message || remote));
  }
}

/**
 * Cancel order(s) in Shiprocket
 */
async function cancelOrder(shiprocketOrderIds) {
  if (!shiprocketOrderIds) throw new Error("shiprocket_order_ids are required for cancellation");

  const ids = Array.isArray(shiprocketOrderIds) ? shiprocketOrderIds : [shiprocketOrderIds];
  const token = await getToken();

  try {
    const res = await axios.post(
      `${API_BASE}/orders/cancel`,
      { ids },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 15000 }
    );

    if (!res.data.success) {
      throw new Error("Shiprocket API failed to cancel order: " + JSON.stringify(res.data));
    }

    return res.data;
  } catch (err) {
    const remote = err.response?.data || err.message;
    console.error("Shiprocket cancelOrder Error:", remote);
    throw new Error("Failed to cancel order: " + (remote?.message || remote));
  }
}

/**
 * Track a Shiprocket order using Shiprocket's order_id
 * 
 * Example:
 *   const tracking = await trackOrder(237157589);
 *   console.log(tracking.current_status);
 */
export async function trackOrder(order_id) {
  if (!order_id) {
    throw new Error("Shiprocket order_id is required for tracking");
  }

  const token = await getToken();

  try {
    const url = `${API_BASE}/courier/track?order_id=${order_id}`;

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    // Shiprocket sometimes wraps tracking_data inside an array
    const trackingObj = Array.isArray(res.data)
      ? res.data[0]?.tracking_data
      : res.data?.tracking_data;

    if (!trackingObj) {
      throw new Error("Tracking data not found in Shiprocket response");
    }

    const shipment = trackingObj.shipment_track?.[0] || {};
    const activities = trackingObj.shipment_track_activities || [];

    return {
      track_status: trackingObj.track_status,               // e.g. 1
      shipment_status: trackingObj.shipment_status,         // e.g. 42
      current_status: shipment.current_status || activities[0]?.activity,
      courier_name: shipment.courier_name || "Unknown",
      awb_code: shipment.awb_code,
      delivered_to: shipment.delivered_to,
      destination: shipment.destination,
      origin: shipment.origin,
      consignee_name: shipment.consignee_name,
      etd: trackingObj.etd,
      track_url: trackingObj.track_url,
      shipment_track: trackingObj.shipment_track || [],
      shipment_track_activities: activities,
      raw: trackingObj, // keep full object for debugging or detail display
    };
  } catch (err) {
    const remote = err.response?.data || err.message;
    console.error("Shiprocket trackOrder Error:", remote);
    throw new Error("Failed to track order: " + (remote?.message || remote));
  }
}



export {
  getToken,
  checkServiceability,
  calculateRates,
  buildFullPayload,
  createOrder,
  updateOrder,
  cancelOrder,
   trackOrder,
};

export default {
  getToken,
  checkServiceability,
  calculateRates,
  buildFullPayload,
  createOrder,
  updateOrder,
  cancelOrder,
  trackOrder,
};
