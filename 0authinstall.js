// oauthInstall.js
// One-shot Authorization Code grant endpoints to acquire an offline
// (non-expiring) access token. Mount these on your Express app, visit /install
// once, complete the OAuth flow, copy the printed token from the logs, save it
// as SHOPIFY_ACCESS_TOKEN in Railway, and you can remove these endpoints.

const crypto = require("crypto");
const express = require("express");

const SHOP = (process.env.SHOPIFY_SHOP || "")
  .replace(/\.myshopify\.com$/i, "")
  .trim();
const SHOP_DOMAIN = `${SHOP}.myshopify.com`;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const BASE_URL = process.env.PUBLIC_BASE_URL;

// Scopes needed for the VIP Club middleware.
const SCOPES = [
  "read_customers",
  "write_customers",
  "read_all_orders",
  "read_orders",
  "read_all_subscription_contracts",
  "write_products",
].join(",");

// In-memory nonce storage. Good enough for a one-shot install.
const pendingNonces = new Map();

function cleanupOldNonces() {
  const cutoff = Date.now() - 10 * 60 * 1000; // 10 minutes
  for (const [nonce, ts] of pendingNonces) {
    if (ts < cutoff) pendingNonces.delete(nonce);
  }
}

/**
 * GET /install
 * Redirects the user (you) to Shopify's grant screen.
 */
function handleInstallStart(req, res) {
  cleanupOldNonces();
  if (!SHOP || !CLIENT_ID || !CLIENT_SECRET || !BASE_URL) {
    return res
      .status(500)
      .send(
        "Missing env: SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, PUBLIC_BASE_URL",
      );
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  pendingNonces.set(nonce, Date.now());

  const redirectUri = `${BASE_URL}/install/callback`;
  const url = new URL(`https://${SHOP_DOMAIN}/admin/oauth/authorize`);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", nonce);
  // No grant_options[] parameter = offline token = non-expiring.

  console.log("[oauth] redirecting to grant screen for", SHOP_DOMAIN);
  return res.redirect(url.toString());
}

/**
 * Verify the HMAC signature on the OAuth callback query string.
 * This is different from webhook HMAC verification.
 */
function verifyCallbackHmac(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  // Sort params alphabetically and serialize.
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");

  const digest = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(message)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

/**
 * GET /install/callback
 * Handles Shopify's redirect, validates, exchanges code for token, prints it.
 */
async function handleInstallCallback(req, res) {
  const { code, shop, state, hmac } = req.query;

  // Check 1: required params
  if (!code || !shop || !state || !hmac) {
    return res.status(400).send("Missing required query parameters.");
  }

  // Check 2: shop hostname format
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
    return res.status(400).send("Invalid shop parameter.");
  }
  if (shop !== SHOP_DOMAIN) {
    return res.status(400).send(`Unexpected shop: ${shop}`);
  }

  // Check 3: nonce matches one we issued
  if (!pendingNonces.has(state)) {
    return res.status(400).send("Invalid or expired state/nonce.");
  }
  pendingNonces.delete(state);

  // Check 4: HMAC is valid
  if (!verifyCallbackHmac(req.query)) {
    return res.status(400).send("HMAC verification failed.");
  }

  // Exchange code for access token
  try {
    const tokenUrl = `https://${SHOP_DOMAIN}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
    });
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    const raw = await tokenRes.text();
    if (!tokenRes.ok) {
      console.error("[oauth] token exchange failed", tokenRes.status, raw);
      return res
        .status(500)
        .send(`Token exchange failed: ${raw.slice(0, 400)}`);
    }

    const data = JSON.parse(raw);
    const token = data.access_token;
    const grantedScope = data.scope;

    // Print VERY clearly in logs — this is what you copy to Railway.
    console.log("\n\n" + "=".repeat(70));
    console.log("SHOPIFY ACCESS TOKEN ACQUIRED");
    console.log("=".repeat(70));
    console.log("Shop:   ", SHOP_DOMAIN);
    console.log("Token:  ", token);
    console.log("Scopes: ", grantedScope);
    console.log("=".repeat(70));
    console.log(
      "\nNext step: set SHOPIFY_ACCESS_TOKEN in Railway to the value above,",
    );
    console.log("then remove or disable the /install endpoints.");
    console.log("=".repeat(70) + "\n\n");

    return res.send(`
      <!DOCTYPE html><html><body style="font-family: system-ui; max-width: 640px; margin: 4em auto;">
        <h1>✅ Install complete</h1>
        <p>The access token has been printed to the Railway logs. Copy it from there (do not copy from this page; the token is sensitive) and save it as <code>SHOPIFY_ACCESS_TOKEN</code> in your Railway environment variables.</p>
        <p><strong>Granted scopes:</strong> ${grantedScope}</p>
        <p>Once saved, remove the <code>/install</code> routes from <code>server.js</code>.</p>
      </body></html>
    `);
  } catch (e) {
    console.error("[oauth] callback error", e);
    return res.status(500).send(`Error: ${e.message}`);
  }
}

function mountOAuthRoutes(app) {
  app.get("/install", handleInstallStart);
  app.get("/install/callback", handleInstallCallback);
}

module.exports = { mountOAuthRoutes };
