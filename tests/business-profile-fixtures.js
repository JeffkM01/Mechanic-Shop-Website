// Synthetic profiles for validation and browser tests only. These values never
// update the checked-in business profile or authorize publishing shop details.
export function draftBusinessProfile() {
  return {
    schemaVersion: 1,
    name: "Synthetic Auto Test Shop",
    contact: { confirmed: false, phone: null, email: null, addressLines: [] },
    privacy: {
      approved: false, effectiveDate: null, hostingProvider: null, databaseProvider: null,
      emailProvider: null, retentionPolicy: null, requestInstructions: null,
    },
    cancellation: { approved: false, effectiveDate: null, policy: "until_start_no_fee" },
  };
}

export function emailOnlyBusinessProfile() {
  const profile = draftBusinessProfile();
  profile.contact.email = "contact@synthetic-shop-unit-check.net";
  profile.contact.emailConfirmed = true;
  return profile;
}

export function unapprovedEmailBusinessProfile() {
  const profile = emailOnlyBusinessProfile();
  profile.contact.emailConfirmed = false;
  return profile;
}

export function approvedBusinessProfile() {
  return {
    schemaVersion: 1,
    name: "Synthetic Auto Test Shop",
    contact: {
      confirmed: true, phone: "202-555-0148", email: "appointments@synthetic-shop-unit-check.net",
      addressLines: ["Synthetic unit-test address", "Not a real shop location"],
    },
    privacy: {
      approved: true, effectiveDate: "2028-02-29", hostingProvider: "Synthetic test host",
      databaseProvider: "Synthetic test database provider", emailProvider: "Synthetic test mail provider",
      retentionPolicy: "Test-only reviewed retention text, not a shop policy.",
      requestInstructions: "Test-only contact instructions, not a customer process.",
    },
    cancellation: { approved: true, effectiveDate: "2028-02-29", policy: "until_start_no_fee" },
  };
}
