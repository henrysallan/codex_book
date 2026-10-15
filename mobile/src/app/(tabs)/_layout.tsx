import { NativeTabs } from "expo-router/unstable-native-tabs";

export default function TabsLayout() {
  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="root">
        <NativeTabs.Trigger.Label>Root</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "folder", selected: "folder.fill" }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="note">
        <NativeTabs.Trigger.Label>Notes</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "doc.text", selected: "doc.text.fill" }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
