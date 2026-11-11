import { formatBookingDate } from "../utils/bookingDates.js";

export default function PolicyNotice({ approved, effectiveDate }) {
  return approved ? <p className="policy-effective">Effective <time dateTime={effectiveDate}>{formatBookingDate(effectiveDate)}</time></p>
    : <aside className="policy-draft" role="status"><strong>Draft — awaiting Edward’s approval</strong><p>This information is awaiting the shop's review. Unconfirmed details below must be completed before public launch.</p></aside>;
}
