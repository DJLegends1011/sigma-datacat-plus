// The sigma-provider-port gate: every class is Sigma's or this extension's, and no stale CL
// pattern remains. check-native-ui.mjs is a copy of the skill's script; SIGMA_DIR names Sigma
// (default D:/ProjectSigma-main). Skipped when Sigma isn't on this device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkNativeUi } from './check-native-ui.mjs';

const sigmaDir = process.env.SIGMA_DIR || 'D:/ProjectSigma-main';

test('UI uses Sigma\'s own classes, no stale CL', { skip: !fs.existsSync(`${sigmaDir}/app`) && 'Sigma not found' }, () => {
    assert.deepEqual(checkNativeUi(new URL('..', import.meta.url), { sigmaDir }).problems, []);
});
