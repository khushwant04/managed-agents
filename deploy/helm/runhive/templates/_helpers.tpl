{{/* Chart name. */}}
{{- define "runhive.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name, max 63 chars (DNS label). */}}
{{- define "runhive.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Name for a component, e.g. "<fullname>-gateway". */}}
{{- define "runhive.componentName" -}}
{{- printf "%s-%s" (include "runhive.fullname" .root | trunc 50 | trimSuffix "-") .component }}
{{- end }}

{{- define "runhive.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "runhive.labels" -}}
helm.sh/chart: {{ include "runhive.chart" . }}
{{ include "runhive.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: runhive
{{- end }}

{{- define "runhive.selectorLabels" -}}
app.kubernetes.io/name: {{ include "runhive.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Labels for a component: (dict "root" $ "component" "gateway") */}}
{{- define "runhive.componentLabels" -}}
{{ include "runhive.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "runhive.componentSelectorLabels" -}}
{{ include "runhive.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "runhive.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "runhive.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "runhive.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/* Name of the Secret holding credentials (created or existing). */}}
{{- define "runhive.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "runhive.fullname" . }}
{{- end }}
{{- end }}

{{- define "runhive.configMapName" -}}
{{- include "runhive.fullname" . }}
{{- end }}

{{/* Service name of the bundled Bitnami Postgres. */}}
{{- define "runhive.postgresql.host" -}}
{{- if .Values.postgresql.fullnameOverride }}
{{- .Values.postgresql.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-postgresql" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/* DATABASE_URL for a chart-created Secret. */}}
{{- define "runhive.databaseUrl" -}}
{{- if .Values.postgresql.enabled }}
{{- $auth := .Values.postgresql.auth }}
{{- $password := required "postgresql.auth.password is required when postgresql.enabled is true" $auth.password }}
{{- printf "postgresql://%s:%s@%s:5432/%s" (urlquery $auth.username) (urlquery $password) (include "runhive.postgresql.host" .) $auth.database }}
{{- else }}
{{- required "Set externalDatabase.url, enable postgresql, or provide secrets.existingSecret with a DATABASE_URL key" .Values.externalDatabase.url }}
{{- end }}
{{- end }}

{{/* Public URL: config.publicUrl, else the first ingress host. */}}
{{- define "runhive.publicUrl" -}}
{{- if .Values.config.publicUrl }}
{{- .Values.config.publicUrl }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts }}
{{- $host := (first .Values.ingress.hosts).host }}
{{- printf "%s://%s" (ternary "https" "http" (gt (len .Values.ingress.tls) 0)) $host }}
{{- end }}
{{- end }}

{{/* Checks that fail early with a clear message. */}}
{{- define "runhive.validate" -}}
{{- $blob := required "config.blobUrl is required (s3://bucket/prefix)" .Values.config.blobUrl }}
{{- if and (hasPrefix "file://" $blob) (not .Values.config.allowFileBlobs) }}
{{- fail "config.blobUrl is a file:// path, which is per-pod storage; use s3://... or set config.allowFileBlobs=true for a single-pod test install" }}
{{- end }}
{{- if not (or (hasPrefix "s3://" $blob) (hasPrefix "file://" $blob)) }}
{{- fail "config.blobUrl must start with s3:// or file://" }}
{{- end }}
{{- if eq .Values.config.sandboxProvider "docker" }}
{{- fail "config.sandboxProvider=docker needs a Docker daemon and is for local development only; use e2b in Kubernetes" }}
{{- end }}
{{- if not .Values.secrets.existingSecret }}
{{- $_ := required "secrets.masterKey is required (base64 of 32 random bytes), or use secrets.existingSecret" .Values.secrets.masterKey }}
{{- end }}
{{- end }}

{{/*
Environment for every component: the ConfigMap via envFrom (see "envFrom")
plus credentials from the Secret, key by key, so an existingSecret may omit
optional keys.
*/}}
{{- define "runhive.secretEnv" -}}
{{- $secret := include "runhive.secretName" . }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: DATABASE_URL
{{- range $key := list "RUNHIVE_MASTER_KEY" "ANTHROPIC_API_KEY" "OPENAI_API_KEY" "E2B_API_KEY" "AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY" }}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $key }}
      optional: true
{{- end }}
{{- if not .Values.secrets.existingSecret }}
{{- range $key, $_ := .Values.secrets.extra }}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $key }}
{{- end }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "runhive.envFrom" -}}
- configMapRef:
    name: {{ include "runhive.configMapName" . }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* Writable scratch dirs under a read-only root filesystem. */}}
{{- define "runhive.volumeMounts" -}}
- name: tmp
  mountPath: /tmp
- name: home
  mountPath: /home/runhive
{{- end }}

{{- define "runhive.volumes" -}}
- name: tmp
  emptyDir: {}
- name: home
  emptyDir: {}
{{- end }}

{{/* Pod-level fields shared by all components: (dict "root" $ "values" .Values.gateway) */}}
{{- define "runhive.podCommon" -}}
{{- $root := .root }}
serviceAccountName: {{ include "runhive.serviceAccountName" $root }}
automountServiceAccountToken: {{ $root.Values.serviceAccount.automountServiceAccountToken }}
{{- with $root.Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $root.Values.podSecurityContext }}
securityContext:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .values.topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
volumes:
  {{- include "runhive.volumes" $root | nindent 2 }}
{{- end }}

{{/* Pod annotations: config/secret checksums trigger rollouts on change. */}}
{{- define "runhive.podAnnotations" -}}
{{- $root := .root }}
checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
{{- if not $root.Values.secrets.existingSecret }}
checksum/secret: {{ include (print $root.Template.BasePath "/secret.yaml") $root | sha256sum }}
{{- end }}
{{- with .values.podAnnotations }}
{{ toYaml . }}
{{- end }}
{{- end }}
