import { Fragment, type ReactNode, useEffect, useId, useState } from 'react';
import { type Localized, useT } from '@/i18n';
import styles from './PresetPicker.module.css';

/** The small part of a vocabulary item the picker needs to search and label. */
export interface PresetPickerItem {
  id: string;
  label: Localized;
}

/** A localized group and the dynamic items that belong to it. */
export interface PresetPickerGroup<T extends PresetPickerItem = PresetPickerItem> {
  key: string;
  label: Localized;
  items: readonly T[];
}

interface Props<T extends PresetPickerItem> {
  groups: readonly PresetPickerGroup<T>[];
  activeId?: string | null;
  renderItem: (item: T, group: PresetPickerGroup<T>) => ReactNode;
}

const searchable = (item: PresetPickerItem): string =>
  `${item.id} ${item.label.en} ${item.label.ja}`.toLowerCase();

/**
 * Pick one item from a vocabulary without turning the group row into a tab
 * strip. Searching temporarily spans every group; an empty search returns to
 * the group the operator had selected before searching.
 */
export function PresetPicker<T extends PresetPickerItem>({
  groups,
  activeId,
  renderItem,
}: Props<T>) {
  const { t, tx } = useT();
  const searchId = useId();
  const availableGroups = groups.filter((group) => group.items.length > 0);
  const firstGroupKey = availableGroups[0]?.key ?? '';
  const [selectedGroupKey, setSelectedGroupKey] = useState(firstGroupKey);
  const [query, setQuery] = useState('');

  // Vocabulary can arrive after the first render or lose a group when the
  // avatar changes. Resolve the visible fallback immediately, then synchronize
  // the stored key so clearing a search keeps that fallback selected.
  const selectedGroup =
    availableGroups.find((group) => group.key === selectedGroupKey) ?? availableGroups[0];
  const resolvedGroupKey = selectedGroup?.key ?? '';

  useEffect(() => {
    if (selectedGroupKey !== resolvedGroupKey) setSelectedGroupKey(resolvedGroupKey);
  }, [resolvedGroupKey, selectedGroupKey]);

  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  const searching = terms.length > 0;
  const matches = (item: T): boolean => {
    const text = searchable(item);
    return terms.every((term) => text.includes(term));
  };

  const resultGroups = searching
    ? availableGroups
        .map((group) => ({ ...group, items: group.items.filter(matches) }))
        .filter((group) => group.items.length > 0)
    : selectedGroup
      ? [selectedGroup]
      : [];
  const resultCount = resultGroups.reduce((count, group) => count + group.items.length, 0);

  return (
    <div className={styles.picker}>
      <div className={styles.searchRow}>
        <label className={styles.searchLabel} htmlFor={searchId}>
          {t('preset.search')}
        </label>
        <div className={styles.searchControl}>
          <input
            id={searchId}
            className={styles.searchInput}
            type="search"
            value={query}
            placeholder={t('preset.search.placeholder')}
            aria-label={t('preset.search')}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <button
            type="button"
            className={styles.clear}
            aria-label={t('preset.search.clear')}
            disabled={query.length === 0}
            onClick={() => setQuery('')}
          >
            ×
          </button>
        </div>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: this is a named set of ordinary pressed buttons, not a form fieldset */}
      <div className={styles.groups} role="group" aria-label={t('preset.groups')}>
        {availableGroups.map((group) => (
          <button
            key={group.key}
            type="button"
            className={styles.groupButton}
            aria-pressed={group.key === resolvedGroupKey}
            data-active={activeId != null && group.items.some((item) => item.id === activeId)}
            title={tx(group.label)}
            onClick={() => {
              setSelectedGroupKey(group.key);
              setQuery('');
            }}
          >
            {tx(group.label)}
          </button>
        ))}
      </div>

      <div className={styles.results} aria-live="polite">
        {resultCount === 0 ? (
          <p className={styles.empty}>{t('preset.search.empty')}</p>
        ) : (
          resultGroups.map((group) => (
            <div className={styles.resultGroup} key={group.key}>
              {searching ? <div className={styles.resultGroupLabel}>{tx(group.label)}</div> : null}
              <div className={styles.items}>
                {group.items.map((item) => (
                  <Fragment key={`${group.key}:${item.id}`}>{renderItem(item, group)}</Fragment>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
