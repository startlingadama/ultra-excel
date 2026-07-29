import { Badge, Card, Grid, Heading, Table, Tabs, Text } from "@radix-ui/themes";
import type { ColumnStats, ProcessingSummary, SheetSummary } from "../api";

interface StatTileProps {
  label: string;
  value: string;
  flagged?: boolean;
}

function StatTile({ label, value, flagged }: StatTileProps) {
  return (
    <Card variant="surface" size="2">
      <div className="ue-stat">
        <div className="ue-stat__value" data-flag={flagged}>
          {value}
        </div>
        <div className="ue-stat__label">{label}</div>
      </div>
    </Card>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatStat(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("fr-FR") : value.toFixed(2);
}

function SheetPanel({ sheet }: { sheet: SheetSummary }) {
  const hasMissing = sheet.missing_values_count > 0;
  const hasDuplicates = sheet.duplicate_rows_count > 0;
  const previewColumns = sheet.columns_names.slice(0, 8); // keep the preview table readable

  return (
    <div style={{ marginTop: 20 }}>
      <Grid columns={{ initial: "2", sm: "4" }} gap="3">
        <StatTile label="Lignes" value={sheet.total_rows.toLocaleString("fr-FR")} />
        <StatTile label="Colonnes" value={sheet.total_columns.toLocaleString("fr-FR")} />
        <StatTile
          label="Valeurs manquantes"
          value={sheet.missing_values_count.toLocaleString("fr-FR")}
          flagged={hasMissing}
        />
        <StatTile
          label="Lignes en double"
          value={sheet.duplicate_rows_count.toLocaleString("fr-FR")}
          flagged={hasDuplicates}
        />
      </Grid>

      <Heading as="h3" size="2" style={{ marginTop: 24, marginBottom: 10 }}>
        Colonnes détectées
      </Heading>
      <Card variant="surface">
        <Table.Root size="1" variant="ghost">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Nom</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Min</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Max</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Moyenne</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {sheet.columns_names.map((name) => {
              const stats: ColumnStats | undefined = sheet.numeric_stats[name];
              return (
                <Table.Row key={name}>
                  <Table.Cell className="ue-mono">{name}</Table.Cell>
                  <Table.Cell>
                    <Badge color="teal" variant="soft" className="ue-mono">
                      {sheet.data_types[name] ?? "?"}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell className="ue-mono">{stats ? formatStat(stats.min) : "-"}</Table.Cell>
                  <Table.Cell className="ue-mono">{stats ? formatStat(stats.max) : "-"}</Table.Cell>
                  <Table.Cell className="ue-mono">{stats ? formatStat(stats.mean) : "-"}</Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      </Card>

      {sheet.sample_rows.length > 0 && (
        <>
          <Heading as="h3" size="2" style={{ marginTop: 24, marginBottom: 10 }}>
            Aperçu des données
          </Heading>
          <Card variant="surface" style={{ overflowX: "auto" }}>
            <Table.Root size="1" variant="ghost">
              <Table.Header>
                <Table.Row>
                  {previewColumns.map((col) => (
                    <Table.ColumnHeaderCell key={col} className="ue-mono">
                      {col}
                    </Table.ColumnHeaderCell>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {sheet.sample_rows.map((row, i) => (
                  <Table.Row key={i}>
                    {previewColumns.map((col) => (
                      <Table.Cell key={col} className="ue-mono">
                        {formatCell(row[col])}
                      </Table.Cell>
                    ))}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card>
          {sheet.columns_names.length > previewColumns.length && (
            <Text as="p" size="1" color="gray" style={{ marginTop: 6 }}>
              Aperçu limité aux {previewColumns.length} premières colonnes sur{" "}
              {sheet.columns_names.length}.
            </Text>
          )}
        </>
      )}

      {hasMissing && (
        <Text as="p" size="1" color="gray" style={{ marginTop: 14 }}>
          {sheet.missing_values_count.toLocaleString("fr-FR")} cellule(s) manquante(s) détectée(s)
          avant nettoyage - un remplissage par propagation (forward-fill) a été appliqué côté worker.
        </Text>
      )}
    </div>
  );
}

export function SummaryView({ summary }: { summary: ProcessingSummary }) {
  const singleSheet = summary.sheets.length <= 1;
  const firstSheet = summary.sheets[0];

  return (
    <div style={{ marginTop: 28 }}>
      <Text as="p" size="1" color="gray" className="ue-mono">
        {summary.filename} · moteur {summary.engine_used} · {summary.total_sheets} feuille(s) ·{" "}
        {summary.execution_time_ms.toFixed(1)} ms
      </Text>

      {singleSheet ? (
        firstSheet && <SheetPanel sheet={firstSheet} />
      ) : (
        <Tabs.Root defaultValue={summary.sheets[0]?.sheet_name} style={{ marginTop: 14 }}>
          <Tabs.List>
            {summary.sheets.map((sheet) => (
              <Tabs.Trigger key={sheet.sheet_name} value={sheet.sheet_name}>
                {sheet.sheet_name}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {summary.sheets.map((sheet) => (
            <Tabs.Content key={sheet.sheet_name} value={sheet.sheet_name}>
              <SheetPanel sheet={sheet} />
            </Tabs.Content>
          ))}
        </Tabs.Root>
      )}
    </div>
  );
}
