{{- define "darm-ann.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "darm-ann.fullname" -}}
{{- printf "%s" (include "darm-ann.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "darm-ann.labels" -}}
app: {{ include "darm-ann.name" . }}
app.kubernetes.io/name: {{ include "darm-ann.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "darm-ann.selectorLabels" -}}
app: {{ include "darm-ann.name" . }}
{{- end -}}
