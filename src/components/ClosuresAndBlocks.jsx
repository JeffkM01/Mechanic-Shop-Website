import { useRef, useState } from "react";
import { DateField, TimeField } from "./SchedulingFields";
import { formatBookingDate, formatShopTimestamp, isBookingDate, shopLocalToUtc } from "../utils/bookingDates";

const emptyBlock = { startDate: "", startTime: "", endDate: "", endTime: "", reason: "" };

export default function ClosuresAndBlocks({
  draft, savedSettings, onChange, disabled = false, dirty = false, onAddBlock, onRemoveBlock,
}) {
  const [closedDate, setClosedDate] = useState("");
  const [closureError, setClosureError] = useState("");
  const [removingClosure, setRemovingClosure] = useState("");
  const [block, setBlock] = useState({ ...emptyBlock });
  const [blockError, setBlockError] = useState("");
  const [removingBlock, setRemovingBlock] = useState("");
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const closedDates = [...(draft.closedDates || [])].sort();
  const timezone = savedSettings.timezone;
  const blocks = [...(savedSettings.blockedPeriods || [])]
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const blockDisabled = disabled || dirty || working;

  function addClosedDate() {
    if (disabled) return;
    if (!isBookingDate(closedDate)) {
      setClosureError("Enter a valid closed date in MM/DD/YYYY format.");
      return;
    }
    if (closedDates.includes(closedDate)) {
      setClosureError(`${formatBookingDate(closedDate)} is already listed as closed.`);
      return;
    }
    if (closedDates.length >= 1000) {
      setClosureError("A maximum of 1,000 closed dates can be saved. Remove an old closure before adding another.");
      return;
    }
    onChange({ closedDates: [...closedDates, closedDate].sort() });
    setClosedDate("");
    setClosureError("");
    setRemovingClosure("");
  }

  function removeClosedDate(date) {
    if (disabled) return;
    onChange({ closedDates: closedDates.filter((item) => item !== date) });
    setRemovingClosure("");
    setClosureError("");
  }

  function changeBlock(name, value) {
    setBlock((current) => ({ ...current, [name]: value }));
    setBlockError("");
  }

  async function addBlock() {
    if (blockDisabled || busy.current) return;
    setBlockError("");
    let startAt;
    let endAt;
    try {
      if (!isBookingDate(block.startDate) || !isBookingDate(block.endDate)) {
        throw new Error("Enter valid start and end dates in MM/DD/YYYY format.");
      }
      if (!block.startTime || !block.endTime) {
        throw new Error("Enter start and end times with AM or PM.");
      }
      startAt = shopLocalToUtc(block.startDate, block.startTime, timezone);
      endAt = shopLocalToUtc(block.endDate, block.endTime, timezone);
      if (Date.parse(endAt) <= Date.parse(startAt)) {
        throw new Error("The blocked period must end after it starts.");
      }
      if (block.reason.length > 200) throw new Error("Keep the reason to 200 characters or fewer.");
      if (blocks.length >= 1000) throw new Error("A maximum of 1,000 blocked periods can be saved.");
    } catch (error) {
      setBlockError(error.code === "INVALID_TIME" ? "Enter valid start and end times with AM or PM, such as 1:00 PM." : error.message);
      return;
    }
    busy.current = true;
    setWorking(true);
    try {
      const added = await onAddBlock({ startAt, endAt, ...(block.reason.trim() ? { reason: block.reason.trim() } : {}) });
      if (added) {
        setBlock({ ...emptyBlock });
        setRemovingBlock("");
      }
    } catch (error) {
      setBlockError(error.message || "The blocked period could not be saved. Please retry.");
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }

  async function removeBlock(id) {
    if (blockDisabled || busy.current) return;
    busy.current = true;
    setWorking(true);
    setBlockError("");
    try {
      if (await onRemoveBlock(id)) setRemovingBlock("");
    } catch (error) {
      setBlockError(error.message || "The blocked period could not be removed. Please retry.");
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }

  return <div className="staff-settings-stack">
    <section className="staff-settings-card" aria-labelledby="staff-closures-heading">
      <div className="staff-settings-heading"><div><p className="staff-settings-kicker">FULL-DAY AVAILABILITY</p><h2 id="staff-closures-heading">Closed dates</h2></div><span className="staff-settings-count">{closedDates.length} listed</span></div>
      <p>Add the dates when the shop will be closed. Holidays are not added automatically. Closure changes take effect after you select Save Changes.</p>
      <div className="staff-settings-add-row">
        <DateField label="Closed date" value={closedDate} onChange={(value) => { setClosedDate(value); setClosureError(""); }} disabled={disabled} />
        <button type="button" className="staff-secondary" onClick={addClosedDate} disabled={disabled}>Add closed date</button>
      </div>
      {closureError && <p className="staff-settings-error" role="alert">{closureError}</p>}
      {closedDates.length === 0 ? <p className="staff-settings-empty">No closed dates are listed.</p> : <ul className="staff-settings-list" aria-label="Closed dates">
        {closedDates.map((date) => <li key={date}>
          <div className="staff-settings-list-summary"><strong><time dateTime={date}>{formatBookingDate(date)}</time></strong><span>Shop closed all day</span></div>
          <div className="staff-settings-list-actions">
            {removingClosure === date ? <div className="staff-settings-confirmation" role="group" aria-label={`Confirm removing closure ${formatBookingDate(date)}`}>
              <p>Remove this closure? This date may become bookable after you save.</p>
              <div className="staff-settings-inline-actions"><button type="button" className="staff-secondary" onClick={() => setRemovingClosure("")} disabled={disabled}>Cancel</button><button type="button" className="staff-danger" onClick={() => removeClosedDate(date)} disabled={disabled}>Remove closure</button></div>
            </div> : <button type="button" className="staff-text-button" onClick={() => setRemovingClosure(date)} disabled={disabled} aria-label={`Remove closed date ${formatBookingDate(date)}`}>Remove</button>}
          </div>
        </li>)}
      </ul>}
    </section>

    <section className="staff-settings-card" aria-labelledby="staff-blocked-heading">
      <div className="staff-settings-heading"><div><p className="staff-settings-kicker">SPECIFIC PERIODS</p><h2 id="staff-blocked-heading">Blocked time</h2></div><span className="staff-settings-count">{blocks.length} saved</span></div>
      <p>Reserve time for a shop commitment without closing the entire date. Blocks are saved immediately using the shop timezone: <strong>{timezone}</strong>.</p>
      <p className="staff-settings-help">Clock-change times that are missing or repeated must be corrected before a block can be saved. Reasons stay staff-only.</p>
      {dirty && <p className="staff-settings-notice" role="status">Save or discard settings changes before managing blocked time.</p>}
      <div className="staff-settings-field-grid">
        <DateField label="Block start date" value={block.startDate} onChange={(value) => changeBlock("startDate", value)} disabled={blockDisabled} />
        <TimeField label="Block start time" value={block.startTime} onChange={(value) => changeBlock("startTime", value)} disabled={blockDisabled} />
        <DateField label="Block end date" value={block.endDate} onChange={(value) => changeBlock("endDate", value)} disabled={blockDisabled} />
        <TimeField label="Block end time" value={block.endTime} onChange={(value) => changeBlock("endTime", value)} disabled={blockDisabled} />
        <label className="staff-settings-field staff-settings-wide">Reason (optional)<input type="text" value={block.reason} onChange={(event) => changeBlock("reason", event.target.value)} maxLength={200} disabled={blockDisabled} placeholder="For example, equipment maintenance" /></label>
      </div>
      <div className="staff-settings-inline-actions"><button type="button" className="staff-primary" onClick={addBlock} disabled={blockDisabled}>{working ? "Saving blocked time…" : "Add Block"}</button></div>
      {blockError && <p className="staff-settings-error" role="alert">{blockError}</p>}
      {blocks.length === 0 ? <p className="staff-settings-empty">No blocked periods are saved.</p> : <ul className="staff-settings-list" aria-label="Saved blocked periods">
        {blocks.map((period) => <li key={period.id}>
          <div className="staff-settings-list-summary"><strong><time dateTime={period.startAt}>{formatShopTimestamp(period.startAt, timezone)}</time> – <time dateTime={period.endAt}>{formatShopTimestamp(period.endAt, timezone)}</time></strong><span>{timezone}</span>{period.reason && <p>{period.reason}</p>}</div>
          <div className="staff-settings-list-actions">
            {removingBlock === period.id ? <div className="staff-settings-confirmation" role="group" aria-label={`Confirm removing block ${formatShopTimestamp(period.startAt, timezone)}`}>
              <p>Remove this block? Its time may become available immediately.</p>
              <div className="staff-settings-inline-actions"><button type="button" className="staff-secondary" onClick={() => setRemovingBlock("")} disabled={blockDisabled}>Cancel</button><button type="button" className="staff-danger" onClick={() => removeBlock(period.id)} disabled={blockDisabled}>Remove block</button></div>
            </div> : <button type="button" className="staff-text-button" onClick={() => setRemovingBlock(period.id)} disabled={blockDisabled} aria-label={`Remove blocked time ${formatShopTimestamp(period.startAt, timezone)}`}>Remove</button>}
          </div>
        </li>)}
      </ul>}
    </section>
  </div>;
}
