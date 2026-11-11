import { useCallback, useEffect, useRef, useState } from "react";
import { rebaseSettings, settingsChanges, settingsPatch, validateSettingsDraft } from "../utils/schedulingSettings";

const copy = value => structuredClone(value);

export default function useSchedulingSettings(request, enabled) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(null);
  const [reloadCount, setReloadCount] = useState(0);
  const alive = useRef(true);
  const locked = useRef(false);
  const initialized = useRef(false);
  const initialRequest = useRef(null);
  const dirty = Boolean(saved && draft && Object.keys(settingsPatch(saved.settings, draft)).length);
  const changes = saved && draft ? settingsChanges(saved.settings, draft) : [];

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!enabled || initialized.current) return;
    let active = true;
    if (!initialRequest.current) initialRequest.current = request("/scheduling/settings");
    initialRequest.current
      .then(data => {
        if (!active) return;
        initialized.current = true;
        setSaved(data); setDraft(copy(data.settings)); setError(""); setLoading(false);
      })
      .catch(failure => { if (active) { setError(failure.message); setLoading(false); } });
    return () => { active = false; };
  }, [enabled, request, reloadCount]);

  function change(patch) {
    if (locked.current || conflict) return;
    setDraft(current => {
      const next = { ...current, ...patch };
      if (["weeklyHours", "breaks", "timezone"].some(key => Object.hasOwn(patch, key) && JSON.stringify(patch[key]) !== JSON.stringify(current[key]))) {
        next.businessHoursVerified = false;
      }
      if (Object.hasOwn(patch, "capacity") && patch.capacity !== current.capacity) next.capacityVerified = false;
      return next;
    });
    setError(""); setNotice("");
  }

  async function save() {
    if (locked.current || !saved || !draft || conflict || !dirty) return false;
    const invalid = validateSettingsDraft(draft, saved.settings);
    if (invalid) { setError(invalid); return false; }
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await request("/scheduling/settings", { method: "PATCH", body: { revision: saved.revision, settings: settingsPatch(saved.settings, draft) } });
      if (!alive.current) return false;
      if (!Number.isInteger(result?.revision) || result.revision <= saved.revision || validateSettingsDraft(result?.settings, saved.settings)) {
        throw new Error("The saved settings response could not be verified.");
      }
      setSaved(result); setDraft(copy(result.settings));
      setNotice("Scheduling changes saved. Customer availability now uses the saved settings.");
      return true;
    } catch (failure) {
      if (!alive.current) return;
      if (!failure.status || failure.status >= 500) {
        setError("We could not verify whether the settings were saved. Reload Latest Settings before reviewing or submitting another change.");
        setConflict({ latest: null, overlaps: [], uncertainSave: true });
      } else {
        setError(failure.message);
        if (failure.status === 409 && failure.code === "SETTINGS_CHANGED") setConflict({ latest: null, overlaps: [] });
      }
      return false;
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  function discard() {
    if (!saved || locked.current) return;
    const snapshot = conflict?.latest || saved;
    setSaved(snapshot); setDraft(copy(snapshot.settings)); setConflict(null); setError("");
    setNotice("Unsaved changes discarded.");
  }

  async function reloadLatest() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const latest = await request("/scheduling/settings");
      if (!alive.current) return;
      if (conflict?.blockReload) {
        setSaved(latest); setDraft(copy(latest.settings)); setConflict(null);
        setNotice("Latest saved settings and blocked time loaded. Review the list before making another change.");
        return;
      }
      const rebased = rebaseSettings(saved.settings, draft, latest.settings);
      setConflict({ latest, overlaps: rebased.conflicts });
      setNotice("Latest saved settings loaded. Compare the saved values with your draft before reviewing further changes.");
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  function reviewLatest() {
    if (!conflict?.latest || locked.current) return;
    const next = rebaseSettings(saved.settings, draft, conflict.latest.settings);
    setSaved(conflict.latest); setDraft(next.draft); setConflict(null); setError("");
    setNotice("Your edits are applied to the latest saved settings for review. Check every change and verify hours or capacity again if needed, then choose Save Changes. Nothing has been saved yet.");
  }

  const blockMutation = useCallback(async (path, options) => {
    if (locked.current || dirty || conflict) return false;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    let committed = false;
    try {
      await request(path, options);
      committed = true;
      // The dedicated block API owns its atomic mutation. Read its new revision
      // rather than reconstructing or submitting blockedPeriods in a PATCH.
      const latest = await request("/scheduling/settings");
      if (!alive.current) return false;
      setSaved(latest); setDraft(copy(latest.settings));
      setNotice(options.method === "POST" ? "Blocked time added. Customer availability has been updated." : "Blocked time removed. Customer availability has been updated.");
      return true;
    } catch (failure) {
      if (alive.current) {
        setError(committed ? "The block change was saved, but the latest schedule could not be loaded. Reload the latest settings before making another change." : failure.message);
        if (committed || !failure.status || failure.code === "SETTINGS_CHANGED") setConflict({ latest: null, overlaps: [], blockReload: true });
      }
      return false;
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }, [request, dirty, conflict]);

  return {
    saved, draft, dirty, changes, loading: loading || Boolean(enabled && !saved && !error), busy, error, notice, conflict,
    change, save, discard, reloadLatest, reviewLatest,
    validate: () => { const invalid = validateSettingsDraft(draft, saved?.settings); setError(invalid); return !invalid; },
    retry: () => { initialRequest.current = null; setError(""); setLoading(true); setReloadCount(value => value + 1); },
    addBlock: body => blockMutation("/scheduling/blocks", { method: "POST", body: { ...body, revision: saved.revision } }),
    removeBlock: id => blockMutation(`/scheduling/blocks/${encodeURIComponent(id)}`, { method: "DELETE", body: { revision: saved.revision } }),
  };
}
