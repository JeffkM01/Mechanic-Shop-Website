import process from "node:process";

// Intentionally no dotenv import or network/database client. Secrets must be
// supplied by the operator's deployment environment, never pasted into output.
async function main() {
  if (process.argv.slice(2).some(argument => argument !== "--json") || process.argv.filter(argument => argument === "--json").length > 1) {
    console.error("Usage: npm run check:launch -- [--json]");
    process.exitCode = 1;
    return;
  }
  try {
    const { checkLaunchConfiguration } = await import("../server/launchChecks.js");
    const report = checkLaunchConfiguration();
    if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("Offline production configuration check. No private env files, network services, or databases were accessed.");
      if (report.configurationReady) console.log("CONFIGURATION CHECKS PASSED. Public launch is still NOT VERIFIED.");
      else {
        console.log("CONFIGURATION BLOCKED. Public launch is NOT VERIFIED.");
        for (const blocker of report.blockers) console.log(`[BLOCKED] ${blocker.code}: ${blocker.message}`);
      }
      for (const check of report.unverified) console.log(`[UNVERIFIED] ${check.code}: ${check.message}`);
      console.log("This command neither approves nor deploys a public launch. Exit 0 means configuration syntax/attestations passed; complete the live checks separately.");
    }
    process.exitCode = report.configurationReady ? 0 : 1;
  } catch {
    console.error("Launch preflight could not read valid public/runtime configuration. Check the documented business-profile schema and installed project files. No launch was approved or attempted.");
    process.exitCode = 1;
  }
}

await main();
