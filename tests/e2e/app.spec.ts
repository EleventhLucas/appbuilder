import { expect, test, _electron as electron } from "@playwright/test";

test("renders a usable startup, recovery, or ready screen", async ({}, testInfo) => {
  const executablePath = process.env.APPBUILDER_E2E_EXECUTABLE;
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...cleanEnvironment } = process.env;
  const userDataPath = testInfo.outputPath("user-data");
  const application = await electron.launch({
    ...(executablePath
      ? { executablePath, args: [`--user-data-dir=${userDataPath}`, "--disable-gpu", "--in-process-gpu", "--use-gl=swiftshader"] }
      : { args: [".", `--user-data-dir=${userDataPath}`, "--disable-gpu", "--in-process-gpu", "--use-gl=swiftshader"] }),
    env: {
      ...cleanEnvironment,
      APPBUILDER_E2E: "1",
      ELECTRON_USER_DATA_DIR: userDataPath,
    },
  });
  try {
    const window = await application.firstWindow();
    await expect(window.locator("body")).not.toBeEmpty();
    await expect(window.getByText(/AppBuilder|Recovery required|No project open/i).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await application.close();
  }
});
