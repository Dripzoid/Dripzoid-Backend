// shiprocket.js
import axios from "axios";

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
const WAREHOUSE_PINCODE = process.env.WAREHOUSE_PINCODE || "533450";
const API_BASE = "https://apiv2.shiprocket.in/v1/external";

let cachedToken = null;
let tokenExpiry = null;

const safeJson = (v, max = 2000) => {
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > max ? s.slice(0, max) + "...(truncated)" : s;
  } catch {
    return String(v);
  }
};

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

  // Shiprocket may return token in different shapes
  const token = res?.data?.token || res?.data?.data?.token || res?.data?.auth_token || null;
  if (!token) {
    console.error("Auth response (no token):", safeJson(res?.data));
    throw new Error("Auth succeeded but token missing in response");
  }

  cachedToken = token;
  tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000); // 23h
  return cachedToken;
}

/**
 * Compute weights (actual, volumetric, chargeable)
 */
function computeWeights({ weight = 1.0, length, breadth, height, volumetric_divisor = 5000 }) {
  const actualWeight = Number.parseFloat(weight) || 0;
  let volumetricWeight = 0;

  if (length && breadth && height) {
    const l = Number.parseFloat(length) || 0;
    const b = Number.parseFloat(breadth) || 0;
    const h = Number.parseFloat(height) || 0;
    if (l > 0 && b > 0 && h > 0) {
      volumetricWeight = (l * b * h) / volumetric_divisor;
    }
  }

  const minimum = 0.5;
  const chargeable = Math.max(actualWeight, volumetricWeight, minimum);

  return {
    actualWeight: Number(actualWeight.toFixed(3)),
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
    console.error("Shiprocket calculateRates Error:", safeJson(remote));
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
    console.error("Shiprocket Serviceability Error:", safeJson(remote));
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
    console.error("Shiprocket createOrder Error:", safeJson(remote));
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
    console.error("Shiprocket updateOrder Error:", safeJson(remote));
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

    if (!res.data?.success) {
      console.error("Cancel response:", safeJson(res.data));
      throw new Error("Shiprocket API failed to cancel order: " + safeJson(res.data));
    }

    return res.data;
  } catch (err) {
    const remote = err.response?.data || err.message;
    console.error("Shiprocket cancelOrder Error:", safeJson(remote));
    throw new Error("Failed to cancel order: " + (remote?.message || remote));
  }
}

/**
 * Generate invoice for a Shiprocket order
 */
async function generateInvoice(shiprocket_order_id) {
  if (!shiprocket_order_id) {
    throw new Error("shiprocket_order_id is required to generate invoice");
  }

  const token = await getToken();

  try {
    const res = await axios.post(
      `${API_BASE}/orders/print/invoice`,
      { ids: [shiprocket_order_id] },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const data = res.data || {};
    if (!data.is_invoice_created || !data.invoice_url) {
      console.error("Invoice generation response:", safeJson(data));
      throw new Error("Invoice generation failed or invoice URL not returned");
    }

    return {
      success: data.is_invoice_created,
      invoice_url: data.invoice_url,
      not_created: data.not_created || [],
    };
  } catch (err) {
    const remote = err.response?.data || err.message;
    console.error("Shiprocket generateInvoice Error:", safeJson(remote));
    throw new Error("Failed to generate invoice: " + (remote?.message || remote));
  }
}

/**
 * Track an order using Shiprocket API and return a normalized tracking object.
 *
 * Accepts variety of Shiprocket response shapes and returns:
 * {
 *   track_status, shipment_status, current_status, courier_name, awb_code, ...
 *   shipment_track, shipment_track_activities, latest_activity, raw, full_response
 * }
 *
 * @param {Object} params
 * @param {string|number} params.order_id - Shiprocket numeric order_id OR channel_order_id (TEMP-xxxx)
 */
async function trackOrder({ order_id }) {
  if (!order_id) {
    throw new Error("Shiprocket order_id is required for tracking");
  }

  const token = await getToken();

  try {
    const url = `${API_BASE}/courier/track?order_id=${encodeURIComponent(order_id)}`;

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    const resData = res.data;

    // Helper: try to extract tracking_data from a single element (array or object)
    const extractFromElement = (el) => {
      if (!el || typeof el !== "object") return null;

      // direct keys
      if (el.tracking_data) return el.tracking_data;
      if (el.tracking) return el.tracking;
      if (el.trackingData) return el.trackingData;

      // Case: { [order_id]: { tracking_data: {...} } }
      // order_id might be number or string; check both
      const keysToTry = [String(order_id), Number(order_id)].filter((k) => k !== "NaN");
      for (const k of keysToTry) {
        if (el[k] && el[k].tracking_data) return el[k].tracking_data;
        if (el[k] && el[k].tracking) return el[k].tracking;
      }

      // scan nested objects to find first tracking_data
      for (const k of Object.keys(el)) {
        const v = el[k];
        if (v && typeof v === "object" && (v.tracking_data || v.tracking || v.trackingData)) {
          return v.tracking_data || v.tracking || v.trackingData;
        }
      }

      return null;
    };

    let trackingObj = null;

    // If array, scan elements
    if (Array.isArray(resData)) {
      for (const el of resData) {
        trackingObj = extractFromElement(el);
        if (trackingObj) break;
      }

      // If still not found, maybe resData itself is array of tracking_data objects
      if (!trackingObj && resData.length === 1 && typeof resData[0] === "object") {
        trackingObj = extractFromElement(resData[0]) || resData[0].tracking_data || resData[0].tracking || null;
      }
    } else if (resData && typeof resData === "object") {
      trackingObj = extractFromElement(resData) || resData.tracking_data || resData.tracking || null;
    }

    if (!trackingObj) {
      console.error("Shiprocket API response (unexpected shape):", safeJson(resData));
      throw new Error("Tracking data not found in Shiprocket response");
    }

    // Normalize shipments and activities
    const shipments = Array.isArray(trackingObj.shipment_track) ? trackingObj.shipment_track : [];
    const activities = Array.isArray(trackingObj.shipment_track_activities)
      ? trackingObj.shipment_track_activities
      : [];

    // Helper to parse possible timestamp fields on activity
    const getActivityTime = (activity) => {
      if (!activity || typeof activity !== "object") return 0;
      const candidates = [
        activity.created_at,
        activity.updated_at,
        activity.activity_date,
        activity.activity_time,
        activity.time,
        activity.date,
        activity.timestamp,
      ];
      for (const c of candidates) {
        if (!c) continue;
        const t = Date.parse(String(c));
        if (!Number.isNaN(t)) return t;
      }
      // fallback: try numeric timestamp fields
      for (const key of Object.keys(activity)) {
        const val = activity[key];
        if (typeof val === "number" && val > 1000000000) return val;
      }
      return 0;
    };

    // Determine "primary" shipment - prefer one with an AWB or the first element
    let primaryShipment = null;
    if (shipments.length === 1) {
      primaryShipment = shipments[0];
    } else if (shipments.length > 1) {
      primaryShipment = shipments.find((s) => s.awb_code || s.awb) || shipments[0];
    } else {
      primaryShipment = {};
    }

    // Determine latest activity (from shipment_track_activities OR per-shipment activity arrays)
    let latestActivity = null;
    if (activities.length > 0) {
      latestActivity = activities.reduce((best, a) => {
        return getActivityTime(a) > getActivityTime(best) ? a : best;
      }, activities[0]);
    } else {
      // maybe each shipment has its own activity arrays
      const allShipmentActs = [];
      for (const s of shipments) {
        if (Array.isArray(s.activities)) allShipmentActs.push(...s.activities);
        if (Array.isArray(s.shipment_track_activities)) allShipmentActs.push(...s.shipment_track_activities);
      }
      if (allShipmentActs.length > 0) {
        latestActivity = allShipmentActs.reduce((best, a) => {
          return getActivityTime(a) > getActivityTime(best) ? a : best;
        }, allShipmentActs[0]);
      }
    }

    // Compose normalized current status
    const currentStatus =
      primaryShipment.current_status ||
      latestActivity?.activity ||
      latestActivity?.status ||
      latestActivity?.message ||
      (typeof trackingObj.track_status !== "undefined" ? String(trackingObj.track_status) : "Unknown");

    return {
      // Basic shiprocket fields
      track_status: trackingObj.track_status ?? null,
      shipment_status: trackingObj.shipment_status ?? null,
      current_status: currentStatus,
      courier_name: primaryShipment.courier_name || primaryShipment.courier || null,
      awb_code: primaryShipment.awb_code || primaryShipment.awb || null,
      delivered_to: primaryShipment.delivered_to || null,
      destination: primaryShipment.destination || null,
      origin: primaryShipment.origin || null,
      consignee_name: primaryShipment.consignee_name || null,
      etd: trackingObj.etd || null,
      track_url: trackingObj.track_url || null,

      // Raw arrays for UI/logging
      shipment_track: shipments,
      shipment_track_activities: activities,
      latest_activity: latestActivity || null,

      // for debugging: return the whole tracking object Shiprocket returned
      raw: trackingObj,
      // include full raw response in case it's nested differently
      full_response: resData,
    };
  } catch (err) {
    const remote = err.response?.data || err.message || err;
    console.error("Shiprocket trackOrder Error:", safeJson(remote));
    throw new Error("Failed to track order: " + (remote?.message || safeJson(remote)));
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
  generateInvoice,
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
  generateInvoice,
};
