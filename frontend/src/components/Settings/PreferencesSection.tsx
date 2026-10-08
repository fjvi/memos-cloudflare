import { create } from "@bufbuild/protobuf";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/store/v1";
import { useUpdateUserGeneralSetting } from "@/store/v1/userSetting";
import { Visibility } from "@/types/proto/api/v1/memo_service_pb";
import { UserSetting_GeneralSetting, UserSetting_GeneralSettingSchema } from "@/types/proto/api/v1/user_service_pb";
import { loadLocale, useTranslate } from "@/utils/i18n";
import { convertVisibilityFromString, convertVisibilityToString } from "@/utils/memo";
import { loadTheme } from "@/utils/theme";
import LocaleSelect from "../LocaleSelect";
import ThemeSelect from "../ThemeSelect";
import VisibilityIcon from "../VisibilityIcon";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem } from "./SettingList";
import SettingSection from "./SettingSection";

const PreferencesSection = () => {
  const t = useTranslate();
  const { currentUser, userGeneralSetting: generalSetting, refetchSettings } = useAuth();
  const { mutate: updateUserGeneralSetting } = useUpdateUserGeneralSetting(currentUser?.name);

  const handleLocaleSelectChange = (locale: Locale) => {
    // 1. 立即更新界面语言并写入本地持久化，防止后端 API 报错被覆盖
    loadLocale(locale);
    localStorage.setItem("memos-locale", locale);

    // 2. 尝试向后端更新设置（添加 onError 容错拦截）
    updateUserGeneralSetting(
      { generalSetting: { locale }, updateMask: ["locale"] },
      {
        onSuccess: () => {
          refetchSettings();
        },
        onError: (err) => {
          console.warn("后端保存偏好配置失败，已切为本地存储模式：", err);
        },
      },
    );
  };

  const handleDefaultMemoVisibilityChanged = (value: string) => {
    // 立即存入本地缓存
    localStorage.setItem("memos-default-visibility", value);

    updateUserGeneralSetting(
      { generalSetting: { memoVisibility: value }, updateMask: ["memo_visibility"] },
      {
        onSuccess: () => {
          refetchSettings();
        },
        onError: (err) => {
          console.warn("后端保存默认可见性失败，已切为本地存储模式：", err);
        },
      },
    );
  };

  const handleThemeChange = (theme: string) => {
    loadTheme(theme);
    updateUserGeneralSetting(
      { generalSetting: { theme }, updateMask: ["theme"] },
      {
        onSuccess: () => {
          refetchSettings();
        },
        onError: (err) => {
          console.warn("后端保存主题设置失败：", err);
        },
      },
    );
  };

  // 优先使用后端 Setting；若后端配置未加载/报错，则读取本地缓存，最次兜底为简体中文 "zh-Hans"
  const savedLocale = (localStorage.getItem("memos-locale") as Locale) || "zh-Hans";
  const savedVisibility = localStorage.getItem("memos-default-visibility") || "PRIVATE";

  const setting: UserSetting_GeneralSetting =
    generalSetting ||
    create(UserSetting_GeneralSettingSchema, {
      locale: savedLocale,
      memoVisibility: savedVisibility,
      theme: "system",
    });

  return (
    <SettingSection title={t("setting.preference.label")}>
      <SettingGroup title={t("setting.preference.appearance-title")} description={t("setting.preference.appearance-description")}>
        <SettingList>
          <SettingListItem label={t("common.language")} description={t("setting.preference.language-description")}>
            <LocaleSelect value={setting.locale} onChange={handleLocaleSelectChange} />
          </SettingListItem>

          <SettingListItem label={t("setting.preference.theme")} description={t("setting.preference.theme-description")}>
            <ThemeSelect value={setting.theme} onValueChange={handleThemeChange} />
          </SettingListItem>
        </SettingList>
      </SettingGroup>

      <SettingGroup
        title={t("setting.preference.memo-defaults-title")}
        description={t("setting.preference.memo-defaults-description")}
        showSeparator
      >
        <SettingList>
          <SettingListItem
            label={t("setting.preference.default-memo-visibility")}
            description={t("setting.preference.default-memo-visibility-description")}
          >
            <Select value={setting.memoVisibility || "PRIVATE"} onValueChange={handleDefaultMemoVisibilityChanged}>
              <SelectTrigger className="min-w-fit">
                <div className="flex items-center gap-2">
                  <VisibilityIcon visibility={convertVisibilityFromString(setting.memoVisibility)} />
                  <SelectValue />
                </div>
              </SelectTrigger>
              <SelectContent>
                {[Visibility.PRIVATE, Visibility.PROTECTED, Visibility.PUBLIC]
                  .map((v) => convertVisibilityToString(v))
                  .map((item) => (
                    <SelectItem key={item} value={item} className="whitespace-nowrap">
                      {t(`memo.visibility.${item.toLowerCase() as Lowercase<typeof item>}`)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </SettingListItem>
        </SettingList>
      </SettingGroup>
    </SettingSection>
  );
};

export default PreferencesSection;
