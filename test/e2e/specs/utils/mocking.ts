/* global browser -- wdio runtime globals */
import { App } from 'obsidian'

import { EAGLE_PLUGIN_ID } from '../../constants'

class MockingUtils {
  async mockUploadedImageUrl(mockedUrl: string) {
    await browser.execute(
      (eaglePluginId: typeof EAGLE_PLUGIN_ID, uploadedImageUrl: string) => {
        // @ts-expect-error 'app' exists in Obsidian
        declare const app: App
        const uploadStub = () => Promise.resolve(uploadedImageUrl)
        app.plugins.plugins[eaglePluginId].eagleUploader.upload = uploadStub
      },
      EAGLE_PLUGIN_ID,
      mockedUrl,
    )
  }
}

export default new MockingUtils()
