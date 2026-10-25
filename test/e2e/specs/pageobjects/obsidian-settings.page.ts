/* global $, $$, WebdriverIO -- wdio runtime globals */
import ObsidianApp from './obsidian-app.page'

class ObsidianSettings {
  async switchToEagleSettingsTab() {
    await $('.vertical-tab-nav-item=Eagle').click()
  }

  async configureEagleHost(host: string) {
    const hostInput = await this.findEagleHostInput()
    await hostInput.setValue(host)
  }

  private async findEagleHostInput() {
    const hostSettingItem = await $$('div.setting-item').find<WebdriverIO.Element>(async (item) => {
      const label = await item.$('.setting-item-info .setting-item-name').getText()
      return label === 'Eagle API Host'
    })
    return hostSettingItem.$('.setting-item-control input[type="text"]')
  }

  async closeSettings() {
    await ObsidianApp.closeModal('Settings')
  }
}

export default new ObsidianSettings()
