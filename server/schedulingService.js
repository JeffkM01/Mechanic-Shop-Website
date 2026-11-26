import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { getService, requiresMechanicApproval } from "../shared/services.js";
import { getServiceCatalog, validateServiceCatalog } from "../shared/serviceCatalog.js";
import { validateDeclineReason } from "../shared/declineReasons.js";
import { validateCancellation } from "../shared/cancellations.js";
import { shopTimezoneFormatter } from "../shared/shopTime.js";
import { defaultSettings, mergeSettings, validateSettings, SchedulingError, buildCandidate, calculateSlots, canFit, legacyOccurrence, dateInZone, localDateTimeToUtc } from "./schedulingRules.js";
import { APPOINTMENT_EMAIL_TEST_FIELD, isOwnedEmailTestRecipient, validateEmailDeliveryScope } from "./appointmentEmailScope.js";
import { prepareMobileLocation, prepareMobileReview, validateMobileBookingPolicy } from "../shared/mobileBooking.js";

const idOf = (value) => String(value);
const overlaps = (a, b) => +new Date(a.startAt) < +new Date(b.occupiedUntil ?? b.endAt) && +new Date(b.startAt) < +new Date(a.occupiedUntil ?? a.endAt);
const conflict = () => new SchedulingError(409, "That start time is no longer available. Please choose another time.", "SLOT_UNAVAILABLE");

export function createSchedulingService({ Appointment, SchedulingState, now = () => new Date(), management = null, deliveryScope = null, mobileBookingPolicy = null }) {
  const emailScope = validateEmailDeliveryScope(deliveryScope);
  const mobilePolicy = validateMobileBookingPolicy(mobileBookingPolicy);
  const getMobileBookingPolicy = () => mobilePolicy;
  // Apply the reviewed mobile allowance only to new availability/bookings.
  // Saved settings and historical appointment snapshots are not rewritten.
  const effectiveSettings = settings => mobilePolicy
    ? { ...settings, bufferMinutes: Math.max(settings.bufferMinutes, mobilePolicy.travelBufferMinutes) }
    : settings;
  async function readState() {
    for (let attempt = 0; attempt < 64; attempt++) {
      const state = await SchedulingState.findById("shop").lean();
      if (!state) {
        try {
          await SchedulingState.create([{ _id: "shop", revision: 0, settingsRevision: 0, settings: defaultSettings(), reservations: [], automaticCounts: [] }], { writeConcern: { w: "majority", j: true } });
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
        continue;
      }
      // Catalog and policy normalization share the booking/settings CAS. Seed
      // once, retain saved estimates and verification, and never enable global
      // automation. Existing appointment strings/snapshots remain untouched.
      let catalog;
      try { catalog = validateServiceCatalog(getServiceCatalog(state.settings)); }
      catch {
        // Never use unverified stored names as Mongo dotted update paths.
        // A malformed saved catalog must fail closed instead of reseeding or
        // silently dropping historical definitions.
        throw new SchedulingError(503, "The saved service catalog needs mechanic review.", "INVALID_STORED_SERVICE_CATALOG");
      }
      const corrections = Object.fromEntries(catalog
        .filter(service => requiresMechanicApproval(service) && state.settings?.serviceRules?.[service.name]
          && state.settings.serviceRules[service.name].requiresApproval !== true)
        .map(service => [`settings.serviceRules.${service.name}.requiresApproval`, true]));
      if (state.settings?.serviceCatalog === undefined) corrections["settings.serviceCatalog"] = catalog.map(service => ({ ...service, legacyNames: [...service.legacyNames] }));
      if (!Object.keys(corrections).length) return state;
      await SchedulingState.updateOne({ _id: "shop", revision: state.revision }, {
        $set: corrections,
        $inc: { revision: 1, settingsRevision: 1 },
      }, { runValidators: true, writeConcern: { w: "majority", j: true } });
    }
    throw new SchedulingError(503, "The schedule is busy. Please retry your request.", "SCHEDULE_BUSY");
  }

  function conservativeLegacyDay(record, settings, originalError) {
    const day = new Date(`${record.date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date) || !Number.isFinite(+day) || day.toISOString().slice(0, 10) !== record.date) throw originalError;
    const tomorrow = new Date(+day + 86_400_000).toISOString().slice(0, 10);
    const timezone = record.scheduling?.timezone || "America/Chicago";
    const startAt = localDateTimeToUtc(record.date, "00:00", timezone);
    const endAt = localDateTimeToUtc(tomorrow, "00:00", timezone);
    // A known legacy date with an unusable time blocks that whole day plus
    // the maximum supported duration/buffer spillover, not every future date.
    return { startAt, endAt, occupiedUntil: new Date(+endAt + (720 + settings.bufferMinutes) * 60_000) };
  }

  async function context(state, clock) {
    const earliest = dateInZone(new Date(+clock - 3 * 86_400_000), state.settings.timezone);
    const appointments = await Appointment.find({ $or: [
      { status: { $in: ["pending", "confirmed", null] }, $or: [
        { date: { $gte: earliest } },
        { date: { $not: /^\d{4}-\d{2}-\d{2}$/ } },
        { "scheduling.occupiedUntil": { $gt: clock } },
        { "scheduling.endAt": { $gt: clock } },
        { "scheduling.startAt": { $gt: clock } },
      ] },
      { _id: { $in: state.reservations.map(reservation => reservation.appointmentId) } },
    ] }).select("_id status date time service createdAt scheduling").lean();
    const records = new Map(appointments.map(record => [idOf(record._id), record]));
    const reservations = state.reservations.filter(reservation => {
      if (["declined", "cancelled"].includes(records.get(idOf(reservation.appointmentId))?.status)) return false;
      if (+new Date(reservation.occupiedUntil) <= +clock) return false;
      return reservation.state === "confirmed" || +new Date(reservation.holdExpiresAt) > +clock;
    });
    const occupied = new Map();
    for (const reservation of reservations) occupied.set(idOf(reservation.appointmentId), { ...reservation, id: idOf(reservation.appointmentId) });
    for (const record of appointments) {
      let occurrence;
      try { occurrence = legacyOccurrence(record, state.settings, clock); }
      catch (error) {
        if (!(error instanceof SchedulingError) || error.code !== "LEGACY_SCHEDULE_INVALID") throw error;
        occurrence = conservativeLegacyDay(record, state.settings, error);
      }
      if (!occurrence || +new Date(occurrence.occupiedUntil ?? occurrence.endAt) <= +clock) continue;
      const id = idOf(record._id);
      const existing = occupied.get(id);
      if (!existing) occupied.set(id, { ...occurrence, id });
      else {
        // Conservative union if an externally modified historical record no
        // longer agrees with its reservation. Never count one request twice.
        existing.startAt = new Date(Math.min(+new Date(existing.startAt), +new Date(occurrence.startAt)));
        existing.occupiedUntil = new Date(Math.max(+new Date(existing.occupiedUntil), +new Date(occurrence.occupiedUntil ?? occurrence.endAt)));
      }
    }
    return { reservations, occupancies: [...occupied.values()] };
  }

  async function commit(decide) {
    // Optimistic serialization backed by MongoDB's unique _id + revision CAS;
    // no process-local lock, expiring mutex lease, or transaction is needed.
    for (let attempt = 0; attempt < 64; attempt++) {
      const state = await readState();
      const clock = new Date(now());
      const current = await context(state, clock);
      const decision = await decide(state, clock, current);
      if (decision.readOnly) return decision.result;
      const next = decision.next;
      const updated = await SchedulingState.updateOne({ _id: "shop", revision: state.revision }, {
        $set: {
          settings: next.settings ?? state.settings,
          settingsRevision: next.settingsRevision ?? state.settingsRevision,
          reservations: next.reservations ?? current.reservations,
          // Counters are historical admissions, not a count of remaining slots.
          automaticCounts: next.automaticCounts ?? state.automaticCounts.filter(item => item.date >= dateInZone(clock, state.settings.timezone)),
        },
        $inc: { revision: 1 },
      }, { runValidators: true, writeConcern: { w: "majority", j: true } });
      if (updated.modifiedCount === 1) return decision.result;
    }
    throw new SchedulingError(503, "The schedule is busy. Please retry your request.", "SCHEDULE_BUSY");
  }

  const automaticEligible = (settings, service) => settings.automaticBookingEnabled
    && settings.businessHoursVerified && settings.capacityVerified
    && service?.active !== false && !requiresMechanicApproval(service)
    && !settings.serviceRules[service.name].requiresApproval;

  function reservationFor(id, candidate, state, clock, confirmed = false, source) {
    return {
      appointmentId: id,
      startAt: candidate.startAt, endAt: candidate.endAt, occupiedUntil: candidate.occupiedUntil,
      durationMinutes: candidate.durationMinutes, bufferMinutes: candidate.bufferMinutes,
      timezone: candidate.timezone, settingsRevision: state.settingsRevision,
      state: confirmed ? "confirmed" : "pending",
      ...(confirmed ? { confirmationSource: source } : { holdExpiresAt: new Date(+clock + state.settings.pendingHoldHours * 3_600_000) }),
    };
  }

  function snapshot(reservation) {
    const { startAt, endAt, occupiedUntil, durationMinutes, bufferMinutes, timezone, holdExpiresAt, settingsRevision, confirmationSource } = reservation;
    return { startAt, endAt, occupiedUntil, durationMinutes, bufferMinutes, timezone, holdExpiresAt, settingsRevision, confirmationSource };
  }

  async function getSettings() {
    const state = await readState();
    return { revision: state.settingsRevision, settings: state.settings, ...(mobilePolicy ? { mobileBooking: mobilePolicy } : {}) };
  }

  async function getPublicServices() {
    const state = await readState();
    return {
      revision: state.settingsRevision,
      ...(mobilePolicy ? { mobileBooking: mobilePolicy } : {}),
      // Only public catalog metadata is returned. No block reasons, staffing,
      // appointment/customer details, or management credentials are included.
      services: getServiceCatalog(state.settings).filter(service => service.active !== false).map(service => ({
        name: service.name, category: service.category, icon: service.icon, description: service.description,
        active: true, provisional: service.provisional, appointmentOnly: service.appointmentOnly,
        legacyNames: [...service.legacyNames],
      })),
    };
  }

  async function getPublicShopHours() {
    const state = await readState();
    const settings = validateSettings(state.settings);
    const verified = settings.businessHoursVerified === true;
    // Customer contact pages use the saved, explicitly verified schedule.
    // Never advertise placeholder hours or expose private blocked periods.
    return {
      verified,
      timezone: settings.timezone,
      weeklyHours: verified ? structuredClone(settings.weeklyHours) : null,
      breaks: verified ? structuredClone(settings.breaks) : [],
      closedDates: verified ? [...settings.closedDates] : [],
    };
  }

  async function updateSettings(patch, { expectedRevision } = {}) {
    return commit((state, _clock, current) => {
      if (expectedRevision !== undefined && expectedRevision !== state.settingsRevision) throw new SchedulingError(409, "Scheduling settings changed. Reload them before saving.", "SETTINGS_CHANGED");
      const settings = mergeSettings(state.settings, patch);
      if (settings.timezone !== state.settings.timezone && current.occupancies.length) throw new SchedulingError(409, "Review or release upcoming appointments before changing the shop timezone.", "ACTIVE_SCHEDULE");
      if (["weeklyHours", "breaks", "closedDates"].some(key => Object.hasOwn(patch, key))) {
        for (const occurrence of current.occupancies) {
          const start = new Date(occurrence.startAt);
          const day = dateInZone(start, settings.timezone);
          const parts = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(start);
          const time = `${parts.find(part => part.type === "hour").value}:${parts.find(part => part.type === "minute").value}`;
          try {
            // Validate geometry only, including ongoing appointments. The
            // service duration is the already committed snapshot, not Oil's
            // current estimate; using a catalog rule does not change it.
            buildCandidate(settings, "Oil Change", day, time, new Date(+start - 1), {
              approval: true,
              durationMinutes: (+new Date(occurrence.endAt) - +start) / 60_000,
              bufferMinutes: (+new Date(occurrence.occupiedUntil) - +new Date(occurrence.endAt)) / 60_000,
            });
          } catch (error) {
            if (!(error instanceof SchedulingError)) throw error;
            throw new SchedulingError(409, "The new calendar conflicts with a held or confirmed appointment. Review affected appointments first.", "CALENDAR_CONFLICT");
          }
        }
      }
      for (const block of settings.blockedPeriods) {
        if (current.occupancies.some(item => overlaps({ startAt: block.startAt, endAt: block.endAt }, item))) throw new SchedulingError(409, "A blocked period conflicts with a held or confirmed appointment. Review the appointment first.", "BLOCK_CONFLICT");
      }
      const events = current.occupancies.flatMap(item => [[+new Date(item.startAt), 1], [+new Date(item.occupiedUntil ?? item.endAt), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let count = 0;
      for (const [, change] of events) {
        count += change;
        if (count > settings.capacity) throw new SchedulingError(409, "Capacity cannot be reduced below existing held or confirmed appointments.", "CAPACITY_CONFLICT");
      }
      const revision = state.settingsRevision + 1;
      return { next: { settings, settingsRevision: revision }, result: { revision, settings, ...(mobilePolicy ? { mobileBooking: mobilePolicy } : {}) } };
    });
  }

  async function getAvailability(service, date) {
    const state = await readState();
    const settings = effectiveSettings(state.settings);
    const clock = new Date(now());
    // Validate syntax and calendar before touching any legacy appointment data.
    const candidates = calculateSlots(settings, service, date, [], clock);
    const current = candidates.length ? await context(state, clock) : { occupancies: [] };
    const slots = candidates.filter(slot => canFit({ ...slot, bufferMinutes: settings.bufferMinutes }, current.occupancies, settings.capacity))
      .map(slot => mobilePolicy ? { ...slot, requiresApproval: true } : slot);
    const definition = getService(service, getServiceCatalog(settings));
    return {
      date,
      ...publicAvailabilityMetadata(settings, definition),
      slots,
      message: mobilePolicy
        ? "Mobile requests require mechanic review of coverage, location and travel before confirmation. Service durations and travel allowances are planning estimates."
        : "Durations are estimates for booking, not guaranteed repair completion times. Requests require approval unless verified automatic booking is enabled and eligible.",
    };
  }

  function publicAvailabilityMetadata(settings, definition) {
    return {
      service: definition.name,
      timezone: settings.timezone,
      durationMinutes: settings.serviceRules[definition.name].durationMinutes,
      policy: {
        minimumNoticeHours: settings.minimumNoticeHours,
        bookingHorizonDays: settings.bookingHorizonDays,
        pendingHoldHours: settings.pendingHoldHours,
        startIncrementMinutes: settings.startIncrementMinutes,
        bufferMinutes: settings.bufferMinutes,
        automaticBookingEnabled: mobilePolicy ? false : settings.automaticBookingEnabled,
        businessHoursVerified: settings.businessHoursVerified,
        capacityVerified: settings.capacityVerified,
      },
      settingsProvisional: !settings.businessHoursVerified || !settings.capacityVerified,
      ...(mobilePolicy ? { mobileBooking: mobilePolicy } : {}),
    };
  }

  async function getCalendarAvailability(service, requestedMonth) {
    if (requestedMonth !== undefined && (typeof requestedMonth !== "string"
      || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth))) {
      throw new SchedulingError(400, "Month must use YYYY-MM.", "INVALID_MONTH");
    }
    const state = await readState();
    const settings = effectiveSettings(state.settings);
    const definition = getService(service, getServiceCatalog(state.settings));
    if (!definition || definition.active === false) throw new SchedulingError(400, "Choose an available listed service.", definition ? "SERVICE_UNAVAILABLE" : "INVALID_SERVICE");
    const clock = new Date(now());
    const today = dateInZone(clock, state.settings.timezone);
    // These are calendar dates, not elapsed shop-local days: advancing UTC
    // midnight preserves leap dates and never shifts at a daylight-saving change.
    const horizon = new Date(`${today}T00:00:00.000Z`);
    horizon.setUTCDate(horizon.getUTCDate() + state.settings.bookingHorizonDays);
    const lastDate = horizon.toISOString().slice(0, 10);
    const month = requestedMonth ?? today.slice(0, 7);
    if (month < today.slice(0, 7) || month > lastDate.slice(0, 7)) {
      throw new SchedulingError(400, "Choose a month within the booking horizon.", "MONTH_OUT_OF_RANGE");
    }
    const current = await context(state, clock);
    const cursor = new Date(`${month}-01T00:00:00.000Z`);
    const days = [];
    for (let index = 0; index < 31; index++) {
      const date = cursor.toISOString().slice(0, 10);
      if (!date.startsWith(`${month}-`) || date > lastDate) break;
      if (date >= today) {
        days.push({
          date,
          available: calculateSlots(settings, definition.name, date, current.occupancies, clock).length > 0,
        });
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return {
      ...publicAvailabilityMetadata(settings, definition),
      month, today, firstDate: today, lastDate, days,
      generatedAt: clock.toISOString(),
    };
  }

  async function createAppointment(value) {
    if (emailScope && !isOwnedEmailTestRecipient(value?.email)) {
      const failure = new SchedulingError(400, "Use the fixed owned inbox while the private appointment email test is active.", "EMAIL_TEST_RECIPIENT_REQUIRED");
      failure.fields = { email: `Use ${emailScope.recipient} for this private email test.` };
      throw failure;
    }
    const location = mobilePolicy ? prepareMobileLocation(value) : null;
    if (location?.error) {
      const failure = new SchedulingError(400, location.error, "INVALID_MOBILE_LOCATION");
      failure.fields = location.fields;
      throw failure;
    }
    const id = new mongoose.Types.ObjectId();
    const reserved = await commit((state, clock, current) => {
      const candidate = buildCandidate(effectiveSettings(state.settings), value.service, value.date, value.time, clock);
      if (!canFit(candidate, current.occupancies, state.settings.capacity)) throw conflict();
      const reservation = reservationFor(id, candidate, state, clock);
      return {
        next: { reservations: [...current.reservations, reservation] },
        result: { reservation, clock, attemptAutomatic: !mobilePolicy && automaticEligible(state.settings, getService(value.service, getServiceCatalog(state.settings))) },
      };
    });
    // Reserve first. A crash/ambiguous insert failure can over-block until hold
    // expiry, but must never release a slot while a write might still commit.
    const appointmentValue = { ...value };
    for (const field of ["city", "state", "postalCode", "mobileVisit"]) delete appointmentValue[field];
    let appointment = await new Appointment({
      ...appointmentValue, _id: id, status: "pending", scheduling: snapshot(reserved.reservation),
      mobileVisit: mobilePolicy ? { ...location.value, travelBufferMinutes: reserved.reservation.bufferMinutes } : undefined,
      // Explicit undefined also discards a caller-forged marker in ordinary
      // mode. Reviews/cancellations never add or replace this creation marker.
      [APPOINTMENT_EMAIL_TEST_FIELD]: emailScope?.runId,
      ...(emailScope ? { email: emailScope.recipient } : {}),
      ...(management?.enabled ? { management: management.createGrant(idOf(id), reserved.clock) } : {}),
    }).save({ writeConcern: { w: "majority", j: true } });
    if (reserved.attemptAutomatic) {
      try { appointment = await reviewAppointment(idOf(id), "confirmed", { automatic: true }); }
      catch (error) {
        if (!(error instanceof SchedulingError) || error.status !== 409) throw error;
        appointment = await Appointment.findById(id).select(`+${APPOINTMENT_EMAIL_TEST_FIELD} +mobileVisit`);
      }
    }
    return appointment;
  }

  // Use the recorded appointment instant and timezone, not current settings or
  // a caller's clock. An expired provisional hold does not cancel the request
  // or remove the customer's ability to cancel it before its scheduled start.
  function getCancellationEligibility(appointment, clock = new Date(now())) {
    const denied = (code, message) => ({ canCancel: false, code, message });
    if (appointment?.status === "cancelled") return denied("ALREADY_CANCELLED", "This appointment has already been cancelled.");
    if (appointment?.status && !["pending", "confirmed"].includes(appointment.status)) {
      return denied("CANCELLATION_NOT_ALLOWED", "This appointment cannot be cancelled online. Please contact the shop.");
    }
    try {
      if (!appointment || !Number.isFinite(+clock)) throw new Error("Missing appointment or server clock");
      const timezone = appointment.scheduling?.timezone || "America/Chicago";
      const formatter = shopTimezoneFormatter(timezone);
      const { date, time } = appointment;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Missing appointment wall time");
      let startAt;
      if (appointment.scheduling?.startAt != null) {
        startAt = new Date(appointment.scheduling.startAt);
        if (!Number.isFinite(+startAt)) throw new Error("Invalid recorded instant");
        const parts = Object.fromEntries(formatter.formatToParts(startAt).map(({ type, value }) => [type, value]));
        // Snapshots can disambiguate a daylight-saving fold, but must still
        // describe the original date/time shown to the customer.
        if (`${parts.year}-${parts.month}-${parts.day}` !== date || `${parts.hour}:${parts.minute}` !== time) throw new Error("Inconsistent recorded time");
      } else startAt = localDateTimeToUtc(date, time, timezone);
      if (+startAt <= +clock) return { ...denied("APPOINTMENT_STARTED", "Online cancellation is no longer available for this appointment. Please contact the shop."), startAt: startAt.toISOString(), timezone };
      return { canCancel: true, code: "CANCELLATION_ALLOWED", message: "You can cancel this appointment until its scheduled start.", startAt: startAt.toISOString(), timezone };
    } catch {
      return denied("SCHEDULE_UNAVAILABLE", "We could not verify this appointment's scheduled time. Please contact the shop to cancel.");
    }
  }

  async function cancelAppointment(id, actor, input = {}) {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new SchedulingError(400, "Invalid appointment ID.");
    if (!["customer", "mechanic"].includes(actor)) throw new SchedulingError(400, "Invalid cancellation actor.");
    for (let attempt = 0; attempt < 16; attempt++) {
      // Lean reads preserve absent legacy status/flags instead of applying
      // schema defaults that would make the conditional write miss the record.
      const appointment = await Appointment.findById(id).select(`+${APPOINTMENT_EMAIL_TEST_FIELD} +mobileVisit`).lean();
      if (!appointment) throw new SchedulingError(404, "Appointment not found.");
      // Repeated requests do not replace the original actor, explanation,
      // timestamp or sent flags, and do not create new notification intents.
      if (appointment.status === "cancelled") return Appointment.findById(id).select(`+${APPOINTMENT_EMAIL_TEST_FIELD} +mobileVisit`);
      const clock = new Date(now());
      const eligibility = getCancellationEligibility(appointment, clock);
      if (!eligibility.canCancel) throw new SchedulingError(409, eligibility.message, eligibility.code);
      const prepared = validateCancellation(actor, input);
      if (prepared.error) {
        const error = new SchedulingError(400, prepared.error, "INVALID_CANCELLATION_REASON");
        error.fields = prepared.fields;
        throw error;
      }
      const flags = appointment.notificationState ?? {};
      const flagNames = ["requestCustomer", "decisionCustomer", "cancellationCustomer", "cancellationMechanic"];
      const filter = { _id: id, status: appointment.status === undefined ? { $exists: false } : appointment.status };
      for (const name of flagNames) {
        // Pin the flags observed in this read. If the dispatcher marks one sent
        // first, retry and preserve it instead of overwriting delivery history.
        filter[`notificationState.${name}`] = flags[name] === undefined ? { $exists: false } : flags[name];
      }
      const change = {
        status: "cancelled",
        cancellation: {
          by: actor, ...prepared.value, cancelledAt: clock,
          originalDate: appointment.date, originalTime: appointment.time,
          timezone: eligibility.timezone,
        },
        "notificationState.cancellationCustomer": flags.cancellationCustomer === "sent" ? "sent" : "pending",
        ...(actor === "customer" ? { "notificationState.cancellationMechanic": flags.cancellationMechanic === "sent" ? "sent" : "pending" } : {}),
        ...(flags.requestCustomer === "pending" ? { "notificationState.requestCustomer": "suppressed" } : {}),
        ...(flags.decisionCustomer === "pending" ? { "notificationState.decisionCustomer": "suppressed" } : {}),
      };
      const cancelled = await Appointment.findOneAndUpdate(filter, { $set: change }, {
        returnDocument: "after", runValidators: true, writeConcern: { w: "majority", j: true },
        projection: `+${APPOINTMENT_EMAIL_TEST_FIELD} +mobileVisit`,
      });
      if (!cancelled) continue;
      // The terminal record and email intents are durable before releasing its
      // own reservation. Context reads also reconcile cancelled reservations
      // if this cleanup fails or a concurrent approval left a stale ledger row.
      await commit((_state, _clock, current) => ({ next: { reservations: current.reservations.filter(item => idOf(item.appointmentId) !== id) }, result: null }));
      return cancelled;
    }
    throw new SchedulingError(409, "This appointment changed. Refresh its status before trying again.", "APPOINTMENT_CHANGED");
  }

  async function reviewAppointment(id, status, { automatic = false, decline, mobileReview } = {}) {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new SchedulingError(400, "Invalid appointment ID.");
    if (!["confirmed", "declined"].includes(status)) throw new SchedulingError(400, "Choose confirmed or declined.");
    if (status === "declined") {
      if (mobileReview !== undefined) throw new SchedulingError(400, "Mobile review is only accepted when confirming an appointment.", "INVALID_MOBILE_REVIEW");
      const prepared = validateDeclineReason(decline);
      if (prepared.error) {
        const failure = new SchedulingError(400, prepared.error, "INVALID_DECLINE_REASON");
        failure.fields = prepared.fields;
        throw failure;
      }
      const pending = { _id: id, $or: [{ status: "pending" }, { status: null }] };
      const change = {
        status,
        decline: { ...prepared.value, declinedAt: new Date(now()), source: "mechanic" },
        "notificationState.decisionCustomer": "pending",
      };
      const options = { returnDocument: "after", runValidators: true, writeConcern: { w: "majority", j: true }, projection: `+${APPOINTMENT_EMAIL_TEST_FIELD} +mobileVisit` };
      // A queued pending receipt would contradict this terminal decision. The
      // conditional branches suppress only an unsent receipt and preserve one
      // already sent, even if the dispatcher changes that flag concurrently.
      let declined = await Appointment.findOneAndUpdate({ ...pending, "notificationState.requestCustomer": "pending" }, {
        $set: { ...change, "notificationState.requestCustomer": "suppressed" },
      }, options);
      if (!declined) declined = await Appointment.findOneAndUpdate({ ...pending, "notificationState.requestCustomer": { $ne: "pending" } }, { $set: change }, options);
      if (!declined) throw new SchedulingError(409, "This request was already reviewed or no longer exists.");
      // Terminal appointment status is persisted before releasing capacity.
      // Reads also reconcile declined reservations if this cleanup is interrupted.
      await commit((_state, _clock, current) => ({ next: { reservations: current.reservations.filter(item => idOf(item.appointmentId) !== id) }, result: null }));
      return declined;
    }
    const appointment = await Appointment.findById(id).select(`+${APPOINTMENT_EMAIL_TEST_FIELD} +mobileVisit`).lean();
    if (!appointment || (appointment.status && appointment.status !== "pending")) throw new SchedulingError(409, "This request was already reviewed or no longer exists.");
    const mobile = Object.hasOwn(appointment, "mobileVisit") && appointment.mobileVisit !== undefined;
    let reviewedMobile;
    if (mobile) {
      if (automatic) throw new SchedulingError(409, "Mobile requests require mechanic review of location and travel.", "MANUAL_APPROVAL_REQUIRED");
      const location = prepareMobileLocation(appointment.mobileVisit);
      const minimum = Math.max(appointment.scheduling?.bufferMinutes ?? 0, appointment.mobileVisit?.travelBufferMinutes ?? NaN);
      if (location.error || !Number.isInteger(minimum) || minimum < 0 || minimum > 120) {
        throw new SchedulingError(409, "The saved mobile visit needs review before it can be confirmed.", "MOBILE_VISIT_INVALID");
      }
      const prepared = prepareMobileReview(mobileReview, minimum);
      if (prepared.error) {
        const failure = new SchedulingError(400, prepared.error, "INVALID_MOBILE_REVIEW");
        failure.fields = prepared.fields;
        throw failure;
      }
      reviewedMobile = prepared.value;
    } else if (mobileReview !== undefined) {
      throw new SchedulingError(400, "This historical request has no recorded mobile review to confirm.", "MOBILE_REVIEW_NOT_REQUIRED");
    }
    const confirmed = await commit((state, clock, current) => {
      const definition = getService(appointment.service, getServiceCatalog(state.settings));
      if (automatic && (!definition || !automaticEligible(state.settings, definition))) throw new SchedulingError(409, "This request requires mechanic approval.", "MANUAL_APPROVAL_REQUIRED");
      if ((appointment.scheduling?.timezone || "America/Chicago") !== state.settings.timezone) throw new SchedulingError(409, "Scheduling conflict: the shop timezone has changed. This request remains pending. Contact the customer to review the appointment time; no replacement time has been offered.", "TIMEZONE_CHANGED");
      // Resolve original snapshots even after their provisional hold expired.
      // This retains partial legacy end/buffer bounds instead of shrinking them
      // to a subsequently edited service estimate or buffer configuration.
      const original = legacyOccurrence({ ...appointment, status: "confirmed" }, state.settings, clock);
      const requestedDate = dateInZone(original.startAt, state.settings.timezone);
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: state.settings.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(original.startAt);
      const requestedTime = `${parts.find(part => part.type === "hour").value}:${parts.find(part => part.type === "minute").value}`;
      // A concurrent approval may already have reserved a longer travel
      // interval before its appointment write settles. Never shrink that
      // admitted interval while a competing booking could claim the gap.
      const held = current.occupancies.find(item => item.id === id);
      const originalBuffer = (+original.occupiedUntil - +original.endAt) / 60_000;
      const admittedBuffer = held ? Math.max(0, (+new Date(held.occupiedUntil ?? held.endAt) - +original.endAt) / 60_000) : 0;
      const bufferMinutes = mobile ? Math.max(originalBuffer, reviewedMobile.travelBufferMinutes, admittedBuffer) : originalBuffer;
      const candidate = buildCandidate(state.settings, appointment.service, requestedDate, requestedTime, clock, {
        approval: true,
        durationMinutes: (+original.endAt - +original.startAt) / 60_000,
        bufferMinutes,
      });
      if (!canFit(candidate, current.occupancies.filter(item => item.id !== id), state.settings.capacity)) throw conflict();
      const counts = state.automaticCounts.filter(item => item.date >= dateInZone(clock, state.settings.timezone)).map(item => ({ ...item }));
      const count = counts.find(item => item.date === candidate.date) || { date: candidate.date, count: 0 };
      const alreadyCounted = current.reservations.some(item => idOf(item.appointmentId) === id && item.confirmationSource === "automatic");
      if (automatic && !alreadyCounted) {
        if (count.count >= state.settings.maxAutomaticPerDay) throw new SchedulingError(409, "The daily automatic confirmation limit has been reached. Mechanic approval is required.", "AUTOMATIC_LIMIT");
        count.count++;
        if (!counts.some(item => item.date === count.date)) counts.push(count);
      }
      const reservation = reservationFor(appointment._id, candidate, state, clock, true, automatic ? "automatic" : "manual");
      return {
        next: { reservations: [...current.reservations.filter(item => idOf(item.appointmentId) !== id), reservation], automaticCounts: counts },
        result: { reservation, clock },
      };
    });
    // A non-expiring confirmed reservation is committed BEFORE approval. If a
    // crash interrupts the second write, keep it conservatively occupied until
    // Edward retries confirmation or declines; never report a false confirmation.
    const pending = { _id: id, $or: [{ status: "pending" }, { status: null }] };
    const change = {
      status: "confirmed",
      scheduling: { ...snapshot(confirmed.reservation), holdExpiresAt: appointment.scheduling?.holdExpiresAt, confirmedAt: confirmed.clock },
      "notificationState.decisionCustomer": "pending",
      ...(mobile ? {
        "mobileVisit.travelBufferMinutes": confirmed.reservation.bufferMinutes,
        "mobileVisit.locationConfirmed": true,
        "mobileVisit.travelConfirmed": true,
        "mobileVisit.reviewedAt": confirmed.clock,
      } : {}),
    };
    const options = { returnDocument: "after", runValidators: true, writeConcern: { w: "majority", j: true }, projection: `+${APPOINTMENT_EMAIL_TEST_FIELD} +mobileVisit` };
    let updated;
    if (automatic) {
      // Status and suppression commit together. A pending receipt must not
      // become a second automatic confirmation. If it was already sent while
      // approval was in flight, preserve that fact and queue the decision only.
      updated = await Appointment.findOneAndUpdate({ ...pending, "notificationState.requestCustomer": "pending" }, {
        $set: { ...change, "notificationState.requestCustomer": "suppressed" },
      }, options);
      if (!updated) updated = await Appointment.findOneAndUpdate({ ...pending, "notificationState.requestCustomer": { $ne: "pending" } }, { $set: change }, options);
    } else {
      updated = await Appointment.findOneAndUpdate(pending, { $set: change }, options);
    }
    if (!updated) throw new SchedulingError(409, "This request was already reviewed or no longer exists.");
    return updated;
  }

  async function addBlockedPeriod(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["startAt", "endAt", "reason", "revision"].includes(key))) throw new SchedulingError(400, "Provide a blocked period with startAt, endAt, and an optional reason and revision.");
    const { revision, ...period } = input;
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw new SchedulingError(400, "Provide a non-negative settings revision.");
    const block = { id: randomUUID(), ...period };
    // Merge against the newest state on every CAS retry, rather than overwriting
    // blocks added by another mechanic request.
    await commit((state, _clock, current) => {
      // The staff UI resolves wall-clock inputs with its saved timezone. Check
      // that exact settings revision inside the same CAS as the block write,
      // including every retry. Older UTC-only clients can omit this guard.
      if (revision !== undefined && revision !== state.settingsRevision) throw new SchedulingError(409, "Scheduling settings changed. Reload them and review the blocked time before saving.", "SETTINGS_CHANGED");
      const settings = mergeSettings(state.settings, { blockedPeriods: [...state.settings.blockedPeriods, block] });
      if (current.occupancies.some(item => overlaps({ startAt: block.startAt, endAt: block.endAt }, item))) throw new SchedulingError(409, "This blocked period conflicts with a held or confirmed appointment.", "BLOCK_CONFLICT");
      return { next: { settings, settingsRevision: state.settingsRevision + 1 }, result: null };
    });
    return block;
  }

  async function removeBlockedPeriod(id, { expectedRevision } = {}) {
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) throw new SchedulingError(400, "Provide a non-negative settings revision.");
    await commit((state) => {
      if (expectedRevision !== undefined && expectedRevision !== state.settingsRevision) throw new SchedulingError(409, "Scheduling settings changed. Reload them and review the blocked time before removing it.", "SETTINGS_CHANGED");
      if (!state.settings.blockedPeriods.some(block => block.id === id)) throw new SchedulingError(404, "Blocked period not found.");
      const settings = mergeSettings(state.settings, { blockedPeriods: state.settings.blockedPeriods.filter(block => block.id !== id) });
      return { next: { settings, settingsRevision: state.settingsRevision + 1 }, result: null };
    });
    return { removed: true };
  }

  return { getSettings, getMobileBookingPolicy, getPublicServices, getPublicShopHours, updateSettings, getAvailability, getCalendarAvailability, createAppointment, reviewAppointment, getCancellationEligibility, cancelAppointment, addBlockedPeriod, removeBlockedPeriod };
}
