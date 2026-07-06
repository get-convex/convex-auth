import { api } from "$convex/_generated/api";
import type { Id } from "$convex/_generated/dataModel";
import { useQuery } from "convex/react";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
  InteractionManager,
} from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";

import { AssigneePicker } from "@/src/components/AssigneePicker";
import { PriorityPicker } from "@/src/components/PriorityPicker";
import { StatusPicker } from "@/src/components/StatusPicker";
import { useAppClient } from "@/src/client";
import { useOverlayRegistration } from "@/src/overlays";
import { useProjectSelection } from "@/src/selection";
import { colors, spacing, fontSize, lineHeight, radius, recipes } from "@/src/theme";
import { Trash, Pencil } from "@/src/icons";
import { useGroupData } from "@/src/groups";

export default function IssueDetail() {
  const client = useAppClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [readyForComments, setReadyForComments] = useState(false);

  useOverlayRegistration(`issue:${id}`);

  React.useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setReadyForComments(true);
    });
    return () => task.cancel();
  }, []);

  const { group, projects } = useGroupData();
  const { selectedProjectId } = useProjectSelection();
  const selectedProject = projects.find((project) => project._id === selectedProjectId) ?? null;
  const members = group?.selectedGroup?.members ?? [];
  const issue = useQuery(
    api.issues.get,
    typeof id === "string" ? { issueId: id as Id<"issues"> } : "skip",
  );

  const commentsData = useQuery(
    api.comments.list,
    readyForComments && issue ? { issueId: issue._id } : "skip",
  );

  type CommentItem = NonNullable<typeof commentsData>[number];
  const comments = commentsData ?? [];

  const updateIssue = useCallback(
    (patch: Record<string, unknown>) => {
      if (!issue) return;
      void client.mutation(api.issues.update, { issueId: issue._id, patch });
    },
    [client, issue],
  );

  const handleTitleSubmit = useCallback(() => {
    setEditingTitle(false);
    if (!issue) return;
    if (titleDraft.trim() && titleDraft.trim() !== issue.title) {
      updateIssue({ title: titleDraft.trim() });
    }
  }, [issue, titleDraft, updateIssue]);

  const handlePostComment = useCallback(async () => {
    if (!issue || !commentText.trim()) return;
    setPosting(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await client.mutation(api.comments.create, {
        issueId: issue._id,
        body: commentText.trim(),
      });
      setCommentText("");
    } finally {
      setPosting(false);
    }
  }, [client, commentText, issue]);

  const handleDeleteComment = useCallback(
    (commentId: Id<"comments">) => {
      Alert.alert("Delete comment?", "This cannot be undone.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => client.mutation(api.comments.remove, { commentId }),
        },
      ]);
    },
    [client],
  );

  const handleDeleteIssue = useCallback(async () => {
    if (!issue) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await client.mutation(api.issues.remove, { issueId: issue._id });
    router.back();
  }, [client, confirmDelete, issue, router]);

  if (!group || !selectedProject || !issue) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.warm[50],
        }}
      >
        <ActivityIndicator color={colors.util.accent} />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.warm[50] }}
      contentContainerStyle={{ paddingBottom: 120 }}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
    >
      <Text
        selectable
        style={{
          fontSize: fontSize.sm + 1,
          fontWeight: "600",
          color: colors.warm[400],
          paddingHorizontal: spacing.lg,
          paddingTop: spacing["2xl"],
        }}
      >
        {issue.identifier}
      </Text>

      {editingTitle ? (
        <TextInput
          style={{
            fontSize: fontSize["2xl"],
            fontWeight: "600",
            color: colors.warm[900],
            lineHeight: lineHeight["2xl"],
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.xs,
            paddingBottom: spacing.md,
            borderBottomWidth: 2,
            borderBottomColor: colors.border.selected,
          }}
          value={titleDraft}
          onChangeText={setTitleDraft}
          onBlur={handleTitleSubmit}
          onSubmitEditing={handleTitleSubmit}
          autoFocus
          multiline
          maxLength={120}
        />
      ) : (
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: spacing.sm,
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.xs,
            paddingBottom: spacing.md,
          }}
        >
          <Text
            selectable
            style={{
              flex: 1,
              fontSize: fontSize["2xl"],
              fontWeight: "600",
              color: colors.warm[900],
              lineHeight: lineHeight["2xl"],
            }}
          >
            {issue.title}
          </Text>
          <Pressable
            onPress={() => {
              setTitleDraft(issue.title);
              setEditingTitle(true);
            }}
            hitSlop={8}
            accessibilityLabel="Edit title"
            style={({ pressed }) => ({
              padding: spacing.xs,
              borderRadius: radius.md,
              backgroundColor: pressed ? colors.background.tertiary : "transparent",
            })}
          >
            <Pencil size={18} color={colors.content.secondary} />
          </Pressable>
        </View>
      )}

      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: colors.warm[200],
          paddingTop: spacing.sm,
          paddingBottom: spacing.xs,
        }}
      >
        <Text
          style={{
            fontSize: 11,
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: 1.6,
            color: colors.warm[500],
            paddingHorizontal: spacing.lg,
            marginBottom: 2,
          }}
        >
          Status
        </Text>
        <StatusPicker value={issue.status} onSelect={(status) => updateIssue({ status })} />
      </View>

      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: colors.warm[200],
          paddingTop: spacing.sm,
          paddingBottom: spacing.xs,
        }}
      >
        <Text
          style={{
            fontSize: 11,
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: 1.6,
            color: colors.warm[500],
            paddingHorizontal: spacing.lg,
            marginBottom: 2,
          }}
        >
          Priority
        </Text>
        <PriorityPicker value={issue.priority} onSelect={(priority) => updateIssue({ priority })} />
      </View>

      {issue.labels.length > 0 && (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: spacing.sm,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.sm,
            borderTopWidth: 1,
            borderTopColor: colors.warm[200],
          }}
        >
          {issue.labels.map((label: string) => (
            <View
              key={label}
              style={{
                paddingHorizontal: spacing.sm + 2,
                paddingVertical: spacing.xs,
                borderRadius: radius.md,
                backgroundColor: colors.warm[100],
                borderWidth: 1,
                borderColor: colors.warm[300],
                borderCurve: "continuous",
              }}
            >
              <Text style={{ fontSize: fontSize.sm, fontWeight: "500", color: colors.warm[600] }}>
                {label}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View
        style={{
          marginTop: spacing.md,
          backgroundColor: colors.white,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.lg,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: colors.warm[200],
        }}
      >
        <Text
          style={{
            fontSize: 11,
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: 1.6,
            color: colors.warm[500],
            marginBottom: spacing.sm + 2,
          }}
        >
          Assignee
        </Text>
        <AssigneePicker
          value={issue.assigneeUserId}
          assigneeName={issue.assigneeName}
          members={members.map((m: { userId: string; name: string }) => ({
            userId: m.userId,
            name: m.name,
          }))}
          onSelect={(userId) => updateIssue({ assigneeUserId: userId })}
        />
      </View>

      <Animated.View
        entering={FadeIn.duration(300)}
        style={{
          marginTop: spacing.md,
          backgroundColor: colors.white,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.lg,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: colors.warm[200],
        }}
      >
        <Text
          style={{
            fontSize: 11,
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: 1.6,
            color: colors.warm[500],
            marginBottom: spacing.sm + 2,
          }}
        >
          Comments{comments.length > 0 ? ` (${comments.length})` : ""}
        </Text>

        {comments.map((comment: CommentItem, idx: number) => (
          <Pressable
            key={comment._id}
            onLongPress={() => handleDeleteComment(comment._id)}
            style={[
              { paddingVertical: spacing.md },
              idx > 0 && {
                borderTopWidth: 1,
                borderTopColor: colors.warm[200],
                marginTop: spacing.xs,
                paddingTop: spacing.md,
              },
            ]}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: spacing.sm,
                marginBottom: spacing.xs + 2,
              }}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  backgroundColor: colors.warm[500],
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ fontSize: 9, fontWeight: "700", color: colors.content.primary }}>
                  {comment.authorName.charAt(0)}
                </Text>
              </View>
              <Text
                style={{ fontSize: fontSize.sm + 1, fontWeight: "600", color: colors.warm[800] }}
              >
                {comment.authorName}
              </Text>
              <Text style={{ fontSize: 11, color: colors.warm[400] }}>
                {new Date(comment.createdAt).toLocaleDateString()}
              </Text>
            </View>
            <Text
              selectable
              style={{
                fontSize: fontSize.md,
                color: colors.warm[700],
                lineHeight: lineHeight.md,
                marginLeft: 30,
              }}
            >
              {comment.body}
            </Text>
          </Pressable>
        ))}

        <View
          style={[
            {
              flexDirection: "row",
              alignItems: "flex-end",
              gap: spacing.sm,
              paddingTop: spacing.md,
            },
            comments.length > 0 && { borderTopWidth: 1, borderTopColor: colors.warm[200] },
          ]}
        >
          <TextInput
            style={{
              ...recipes.input,
              flex: 1,
              fontSize: fontSize.md,
              minHeight: 38,
              maxHeight: 100,
            }}
            value={commentText}
            onChangeText={setCommentText}
            placeholder="Add a comment…"
            placeholderTextColor={colors.warm[400]}
            multiline
            maxLength={500}
          />
          <Pressable
            onPress={handlePostComment}
            disabled={!commentText.trim() || posting}
            style={({ pressed }) => ({
              ...recipes.buttonAccent,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm + 1,
              ...(pressed ? recipes.buttonAccentPressed : null),
              opacity: !commentText.trim() || posting ? 0.4 : 1,
            })}
          >
            {posting ? (
              <ActivityIndicator color={colors.content.primary} size="small" />
            ) : (
              <Text
                style={{ fontSize: fontSize.md, fontWeight: "600", color: colors.content.primary }}
              >
                Post
              </Text>
            )}
          </Pressable>
        </View>
      </Animated.View>

      <View
        style={{
          marginTop: spacing["2xl"],
          paddingHorizontal: spacing.lg,
          alignItems: "center",
          gap: spacing.sm,
        }}
      >
        <Pressable
          onPress={handleDeleteIssue}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm - 2,
            paddingVertical: spacing.md,
            paddingHorizontal: spacing["2xl"],
            borderRadius: radius.md,
            borderCurve: "continuous",
            backgroundColor: confirmDelete || pressed ? colors.background.error : "transparent",
          })}
        >
          <Trash size={15} color={confirmDelete ? colors.content.error : colors.warm[500]} />
          <Text
            style={{
              fontSize: fontSize.md,
              fontWeight: confirmDelete ? "600" : "500",
              color: confirmDelete ? colors.content.error : colors.warm[500],
            }}
          >
            {confirmDelete ? "Confirm Delete" : "Delete Issue"}
          </Text>
        </Pressable>
        {confirmDelete && (
          <Pressable onPress={() => setConfirmDelete(false)}>
            <Text style={{ fontSize: fontSize.sm + 1, color: colors.warm[500] }}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}
