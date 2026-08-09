import assert from "node:assert/strict";
import test from "node:test";

import { enrollmentCodePresentation } from "./enrollment-code.js";

test("le code numérique est affiché par groupes et copié sans tirets", () => {
  assert.deepEqual(enrollmentCodePresentation("1234567890123456"), {
    clipboard: "1234567890123456",
    formatted: "1234-5678-9012-3456",
    numeric: true,
    valid: true,
  });
  assert.deepEqual(enrollmentCodePresentation("1234 5678-9012 3456"), {
    clipboard: "1234567890123456",
    formatted: "1234-5678-9012-3456",
    numeric: true,
    valid: true,
  });
});

test("un ancien code alphanumérique reste accepté et inchangé", () => {
  assert.deepEqual(enrollmentCodePresentation(" 2345-6789-abcd-efgh "), {
    clipboard: "2345-6789-ABCD-EFGH",
    formatted: "2345-6789-ABCD-EFGH",
    numeric: false,
    valid: true,
  });
});

test("les codes incomplets ou mélangés restent refusés", () => {
  assert.equal(enrollmentCodePresentation("1234-5678").valid, false);
  assert.equal(enrollmentCodePresentation("1-234567890123456").valid, false);
  assert.equal(enrollmentCodePresentation("1234-5678-90AB-CDEF").valid, false);
  assert.equal(enrollmentCodePresentation("").valid, false);
});
