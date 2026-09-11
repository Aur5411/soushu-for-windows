'use strict';

/**
 * 单一版本号来源，界面标题栏和元数据都会读它。
 *
 * APP_NAME 用 ASCII：它决定用户数据目录（%APPDATA%\Soushuba），
 * 路径里避免中文可以少一堆编码麻烦。界面上显示的一律是 CODENAME。
 */
module.exports = {
  VERSION: '1.2.12',
  CODENAME: '搜书吧',
  APP_NAME: 'Soushuba',
  APP_ID: 'com.soushuba.pc'
};
