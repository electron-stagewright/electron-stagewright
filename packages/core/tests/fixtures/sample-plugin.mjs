// Minimal valid plugin fixture for importPlugin tests — a default-exported StagewrightPlugin
// with no tools or codes (importPlugin only validates the name/version shape).
export default {
  name: 'fixturep',
  version: '1.0.0',
  coreVersionRange: '*',
}
