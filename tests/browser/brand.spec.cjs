const { test, expect } = require('@playwright/test');
const fs = require('fs');
const vm = require('vm');

test('extension accepts only the verified Vyrani testing origin as a hosted producer', () => {
  const context = vm.createContext({ URL, chrome: {
    storage: { local: { get: (_keys, callback) => callback({}) } },
    runtime: { onConnect: { addListener() {} } },
  } });
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  const accepts = url => vm.runInContext(`isAllowedStudioSender({ url: ${JSON.stringify(url)} })`, context);
  expect(accepts('https://vyrani.blackhevents.com/app/studio?mode=photo')).toBe(true);
  expect(accepts('http://localhost:8765/app/studio')).toBe(true);
  for (const url of ['https://vyrani.blackhevents.com.evil.example/app/studio',
    'https://vyrani.blackhevents.com/signin', 'https://vyra.ai/app/studio',
    'https://app.vyra.ai/app/studio', 'https://vyrani.com/app/studio', 'https://meet.google.com/app/studio']) {
    expect(accepts(url)).toBe(false);
  }
});
