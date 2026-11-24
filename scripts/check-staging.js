import process from "node:process";

// No dotenv or index.js: inherited operator settings only, never private files.
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    console.error("Usage: npm run check:staging -- [--json]");
    process.exitCode = 1;
  } else {
    const { checkStagingConfiguration } = await import("../server/stagingChecks.js");
    const report = checkStagingConfiguration();
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("Offline protected-staging check. No private env files, network services, or databases were accessed.");
      console.log(report.configurationReady ? "CONFIGURATION CHECKS PASSED. Deployment still requires explicit approval." : "CONFIGURATION BLOCKED. Nothing was deployed.");
      for (const blocker of report.blockers) console.log(`[BLOCKED] ${blocker.code}: ${blocker.message}`);
      for (const item of report.unverified) console.log(`[UNVERIFIED] ${item}`);
      console.log(`Staging keeps ordinary appointment email disabled. The fixed-inbox manual test is ${report.emailConnectionTestEnabled ? "enabled" : "disabled"}. Public bookings are not approved.`);
    }
    process.exitCode = report.configurationReady ? 0 : 1;
  }
} catch {
  console.error("Staging preflight could not validate configuration. Check the documented runtime settings and installed project files; nothing was deployed.");
  process.exitCode = 1;
}
