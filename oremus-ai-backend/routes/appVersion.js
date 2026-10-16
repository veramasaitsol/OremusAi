'use strict';
const express = require('express');
const router  = express.Router();

// PUBLIC (no JWT) — mobile app polls this on launch to decide whether to
// prompt / force an update. Bump the versions + priority here on each release.
// priority: 'low' | 'medium' → optional update; 'high' | 'maintenance' → force update.

const STORE = {
  android: 'https://play.google.com/store/apps/details?id=com.oremusai',
  ios: 'https://apps.apple.com/in/app/gaswale/id6745095531',
};

const MSG =
  'New version of Gaswale is available on Playstore/App Store, Please update to use app.';

const CONFIG = {
  priority: 'low',

  android_latest_version: '1.0.1',
  android_minimum_version: '1.0.0',

  ios_latest_version: '1.0.0',
  ios_minimum_version: '1.0.0',
};

router.get('/', (_req, res) => {
  const c = CONFIG;

  res.json({
    success: true,

    android: {
      latest_version: c.android_latest_version,
      minimum_version: c.android_minimum_version,
    },

    ios: {
      latest_version: c.ios_latest_version,
      minimum_version: c.ios_minimum_version,
    },

    force_update:
      c.priority === 'high' || c.priority === 'maintenance',

    update_message: MSG,

    download_url: STORE,
  });
});

module.exports = router;
