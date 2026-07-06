import * as Haptics from "expo-haptics";
import { Stack, router, useLocalSearchParams } from "expo-router";
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { useOverlayRegistration } from "@/src/overlays";
import { useProjectSelection } from "@/src/selection";
import { colors, spacing, fontSize, recipes } from "@/src/theme";
import { Check, ChevronRight } from "@/src/icons";
import { type GroupProject, useGroupData } from "@/src/groups";

export default function ProjectPickerScreen() {
  const params = useLocalSearchParams<{ project?: string }>();
  const { projects } = useGroupData();
  const { setSelectedProjectId } = useProjectSelection();

  useOverlayRegistration("project-picker");

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing["3xl"] - 4 }}
      style={{ flex: 1, backgroundColor: colors.warm[50] }}
    >
      <Stack.Screen options={{ title: "Projects" }} />

      <View style={{ ...recipes.sheet, overflow: "hidden" }}>
        {projects.map((project: GroupProject) => {
          const active = project._id === params.project;
          return (
            <Pressable
              key={project._id}
              onPress={() => {
                void Haptics.selectionAsync();
                setSelectedProjectId(project._id);
                router.dismiss();
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: spacing.sm,
                paddingHorizontal: spacing.lg - 2,
                paddingVertical: spacing.md - 1,
                ...recipes.rowBorder,
                backgroundColor: pressed || active ? colors.background.tertiary : "transparent",
              })}
            >
              <View style={{ flex: 1, gap: spacing.xs, paddingRight: spacing.md }}>
                <Text
                  selectable
                  style={{
                    fontSize: fontSize.xs,
                    letterSpacing: 1.2,
                    textTransform: "uppercase",
                    color: colors.warm[400],
                    fontWeight: "700",
                  }}
                >
                  {project.identifier}
                </Text>
                <Text
                  selectable
                  numberOfLines={1}
                  style={{
                    fontSize: fontSize.lg,
                    color: colors.warm[900],
                    fontWeight: "500",
                  }}
                >
                  {project.name}
                </Text>
              </View>
              <Text
                selectable
                style={{
                  minWidth: 28,
                  textAlign: "right",
                  fontSize: fontSize.sm,
                  color: colors.util.accent,
                  fontVariant: ["tabular-nums"],
                  fontWeight: "700",
                }}
              >
                {project.openIssueCount}
              </Text>
              {active ? (
                <Check size={16} color={colors.util.accent} />
              ) : (
                <ChevronRight size={16} color={colors.warm[400]} />
              )}
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}
