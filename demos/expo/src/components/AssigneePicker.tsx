import React, { useState } from "react";
import { View, Text, Pressable } from "react-native";

import { colors, spacing, fontSize, radius } from "@/src/theme";
import { ChevronRight } from "@/src/icons";

interface Member {
  userId: string;
  name: string;
}

export function AssigneePicker({
  value,
  assigneeName,
  members,
  onSelect,
}: {
  value: string | null;
  assigneeName: string | null;
  members: Member[];
  onSelect: (userId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingVertical: spacing.sm,
        }}
      >
        {assigneeName ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                backgroundColor: colors.util.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{ fontSize: fontSize.sm, fontWeight: "700", color: colors.content.primary }}
              >
                {assigneeName.charAt(0)}
              </Text>
            </View>
            <Text style={{ fontSize: fontSize.lg - 1, fontWeight: "500", color: colors.warm[800] }}>
              {assigneeName}
            </Text>
          </View>
        ) : (
          <Text style={{ fontSize: fontSize.lg - 1, color: colors.warm[400] }}>Unassigned</Text>
        )}
        <View style={{ transform: [{ rotate: expanded ? "-90deg" : "90deg" }] }}>
          <ChevronRight size={14} color={colors.warm[400]} />
        </View>
      </Pressable>

      {expanded && (
        <View
          style={{
            marginTop: spacing.sm,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border.transparent,
            backgroundColor: colors.background.secondary,
            overflow: "hidden",
            borderCurve: "continuous",
          }}
        >
          <Pressable
            onPress={() => {
              onSelect(null);
              setExpanded(false);
            }}
            style={({ pressed }) => ({
              paddingHorizontal: spacing.lg - 2,
              paddingVertical: spacing.sm + 2,
              borderBottomWidth: 1,
              borderBottomColor: colors.border.transparent,
              backgroundColor: !value || pressed ? colors.background.tertiary : "transparent",
            })}
          >
            <Text
              style={{
                fontSize: fontSize.md,
                color: !value ? colors.content.primary : colors.warm[700],
                fontWeight: !value ? "600" : "400",
              }}
            >
              Unassigned
            </Text>
          </Pressable>
          {members.map((member) => {
            const active = value === member.userId;
            return (
              <Pressable
                key={member.userId}
                onPress={() => {
                  onSelect(member.userId);
                  setExpanded(false);
                }}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.sm,
                  paddingHorizontal: spacing.lg - 2,
                  paddingVertical: spacing.sm + 2,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border.transparent,
                  backgroundColor: active || pressed ? colors.background.tertiary : "transparent",
                })}
              >
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    backgroundColor: colors.warm[400],
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ fontSize: 9, fontWeight: "700", color: colors.content.primary }}>
                    {member.name.charAt(0)}
                  </Text>
                </View>
                <Text
                  style={{
                    fontSize: fontSize.md,
                    color: active ? colors.content.primary : colors.warm[700],
                    fontWeight: active ? "600" : "400",
                  }}
                >
                  {member.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}
