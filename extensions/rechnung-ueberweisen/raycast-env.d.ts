/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `rechnung-ueberweisen` command */
  export type RechnungUeberweisen = ExtensionPreferences & {}
  /** Preferences accessible in the `rechnung-aus-paperless` command */
  export type RechnungAusPaperless = ExtensionPreferences & {
  /** Paperless-ngx Server URL - Basisadresse deiner Paperless-ngx-Instanz */
  "paperlessUrl": string,
  /** Paperless-ngx API Token - API-Token aus dem Paperless-Profil */
  "paperlessToken": string
}
}

declare namespace Arguments {
  /** Arguments passed to the `rechnung-ueberweisen` command */
  export type RechnungUeberweisen = {}
  /** Arguments passed to the `rechnung-aus-paperless` command */
  export type RechnungAusPaperless = {}
}

