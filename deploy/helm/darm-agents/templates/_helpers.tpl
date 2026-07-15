{{- define "darm-agents.name" -}}darm-agents{{- end -}}

{{- define "darm-agents.labels" -}}
app.kubernetes.io/name: darm-agents
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "darm-agents.tsSecret" -}}
{{- if .Values.tailscale.existingSecret -}}{{ .Values.tailscale.existingSecret }}{{- else -}}{{ .Release.Name }}-darm-agents-ts{{- end -}}
{{- end -}}

{{- define "darm-agents.authSecret" -}}
{{- if .Values.auth.existingSecret -}}{{ .Values.auth.existingSecret }}{{- else -}}{{ .Release.Name }}-darm-agents-auth{{- end -}}
{{- end -}}
