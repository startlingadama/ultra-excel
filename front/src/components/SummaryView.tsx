import { Badge, Card, Grid, Heading, Table, Text } from "@radix-ui/themes";
import type { ProcessingSummary } from "../api";

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

export function SummaryView({ summary }: { summary: ProcessingSummary }) {
  const hasMissing = summary.missing_values_count > 0;

  return (
    <div style={{ marginTop: 28 }}>
      <Grid columns={{ initial: "2", sm: "4" }} gap="3">
        <StatTile label="Lignes" value={summary.total_rows.toLocaleString("fr-FR")} />
        <StatTile label="Colonnes" value={summary.total_columns.toLocaleString("fr-FR")} />
        <StatTile
          label="Valeurs manquantes"
          value={summary.missing_values_count.toLocaleString("fr-FR")}
          flagged={hasMissing}
        />
        <StatTile label="Temps de traitement" value={`${summary.execution_time_ms.toFixed(1)} ms`} />
      </Grid>

      <Heading as="h2" size="3" style={{ marginTop: 28, marginBottom: 10 }}>
        Colonnes détectées
      </Heading>

      <Card variant="surface">
        <Table.Root size="1" variant="ghost">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Nom</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {summary.columns_names.map((name) => (
              <Table.Row key={name}>
                <Table.Cell className="ue-mono">{name}</Table.Cell>
                <Table.Cell>
                  <Badge color="teal" variant="soft" className="ue-mono">
                    {summary.data_types[name] ?? "?"}
                  </Badge>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Card>

      {hasMissing && (
        <Text as="p" size="1" color="gray" style={{ marginTop: 10 }}>
          {summary.missing_values_count.toLocaleString("fr-FR")} cellule(s) manquante(s) détectée(s)
          avant nettoyage — un remplissage par propagation (forward-fill) a été appliqué côté worker.
        </Text>
      )}
    </div>
  );
}
