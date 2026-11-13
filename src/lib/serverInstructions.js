'use strict';

// The text a client receives as `instructions` in the initialize reply: what
// XNS is, what the 15 tools do, the first tool to run, and where Claude users
// find the step-by-step skills. It must read correctly with no plugin installed.
module.exports = 'XNS is S3-compatible cloud object storage. $6.00 per TB per month. $0 egress, uncapped. 30-day minimum retention, no early-delete fee. You reach it through the Relayer, a small gateway that runs on your own machine, so the S3 endpoint and keys stay on hardware you control.'
    + ' These 15 tools set the Relayer up and manage it: check the machine, create an XNS account in the browser, install and claim the Relayer, choose which hosts store the data, verify an S3 round trip, write CLI credentials, then change settings, restart services and back up the configuration.'
    + ' Start with check_prerequisites.'
    + " In Claude, the xns-storage plugin's skills (set-up-xns-storage and use-xns-storage) hold the step-by-step."
    + ' In Claude Code, install it with /plugin marketplace add xns-cloud/xns-storage-plugin and then /plugin install xns-storage@xns-cloud.'
    + ' The tools work the same without the plugin.';
