import i18n, { BackendModule, FallbackLng, FallbackLngObjList } from "i18next";
import { orderBy } from "lodash-es";
import { initReactI18next } from "react-i18next";
import { findNearestMatchedLanguage } from "./utils/i18n";

export const locales = orderBy([
  "ar",
  "ca",
  "cs",
  "de",
  "en",
  "en-GB",
  "es",
  "fa",
  "fr",
  "gl",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ka-GE",
  "ko",
  "mr",
  "nb",
  "nl",
  "pl",
  "pt-PT",
  "pt-BR",
  "ru",
  "sl",
  "sv",
  "th",
  "tr",
  "uk",
  "vi",
  "zh-Hans",
  "zh-Hant",
]);

const fallbacks = {
  "zh-HK": ["zh-Hant", "en"],
  "zh-TW": ["zh-Hant", "en"],
  zh: ["zh-Hans", "en"],
} as FallbackLngObjList;

const LazyImportPlugin: BackendModule = {
  type: "backend",
  init: function () {},
  read: function (language, _, callback) {
    const matchedLanguage = findNearestMatchedLanguage(language);
    import(`./locales/${matchedLanguage}.json`)
      .then((translationModule: Record) => {
        callback(null, (translationModule.default as Record) ?? translationModule);
      })
      .catch(() => {
        // 如果找不到对应语言，回退加载简体中文 zh-Hans.json 而不是 en.json
        import("./locales/zh-Hans.json")
          .then((translationModule: Record) => {
            callback(null, (translationModule.default as Record) ?? translationModule);
          })
          .catch((error: unknown) => {
            callback(error as Error, false);
          });
      });
  },
};

i18n
  .use(LazyImportPlugin)  .use(initReactI18next)
  .init({
    lng: "zh-Hans", // 1. 强制设定当前默认语言为简体中文
    detection: {
      order: [], // 2. 禁用浏览器环境自动检测（清空 order），防止被覆盖
    },
    interpolation: {
      escapeValue: false,
    },
    fallbackLng: {
      ...fallbacks,
      ...{ default: ["zh-Hans"] }, // 3. 将默认回退语言由 ["en"] 改为 ["zh-Hans"]
    } as FallbackLng,
  });

export default i18n;
export type TLocale = (typeof locales)[number];