import mongoose from "mongoose";

// This entire subdocument is excluded by Appointment's default projection.
// Neither bearer links nor raw browser session credentials are persisted.
const managementSessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  issuedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { _id: false });

export const managementSchema = new mongoose.Schema({
  nonce: { type: String, required: true, match: /^[A-Za-z\d_-]{43}$/ },
  tokenHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  keyId: { type: String, required: true, match: /^[a-f\d]{32}$/ },
  issuedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  sessions: { type: [managementSessionSchema], default: [] },
}, { _id: false });

export default managementSchema;
