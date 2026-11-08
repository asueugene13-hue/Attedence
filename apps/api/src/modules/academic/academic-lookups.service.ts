import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

/**
 * Read-only answers about the academic structure for other modules (students, courses, users), so they
 * never query academic tables themselves (CLAUDE.md rule 8). "Active" for a programme means the
 * programme, its department and its faculty are all active.
 */
@Injectable()
export class AcademicLookupsService {
  constructor(private readonly prisma: PrismaService) {}

  async programme(id: string) {
    const p = await this.prisma.programme.findUnique({
      where: { id },
      include: { department: { include: { faculty: true } } },
    });
    if (!p) return null;
    return {
      id: p.id,
      code: p.code,
      departmentId: p.departmentId,
      facultyId: p.department.facultyId,
      isActive: p.isActive && p.department.isActive && p.department.faculty.isActive,
    };
  }

  async level(id: string) {
    const l = await this.prisma.academicLevel.findUnique({ where: { id } });
    return l ? { id: l.id, code: l.code, isActive: l.isActive } : null;
  }

  /** A department with its faculty, as scope checks need it. */
  async department(id: string) {
    const d = await this.prisma.department.findUnique({ where: { id } });
    return d ? { id: d.id, facultyId: d.facultyId, isActive: d.isActive } : null;
  }

  async semester(id: string) {
    const s = await this.prisma.semester.findUnique({ where: { id } });
    return s ? { id: s.id, academicYearId: s.academicYearId, number: s.number, status: s.status } : null;
  }

  /** Whether a faculty or department exists and is active (for scoped role grants). */
  async scopeTargetActive(type: 'FACULTY' | 'DEPARTMENT', id: string): Promise<boolean> {
    const row =
      type === 'FACULTY'
        ? await this.prisma.faculty.findUnique({ where: { id } })
        : await this.prisma.department.findUnique({ where: { id } });
    return Boolean(row?.isActive);
  }

  /** Codes and labels as staff entered them, for checking import files. */
  async importLookups() {
    const [programmes, levels, years] = await Promise.all([
      this.prisma.programme.findMany({ include: { department: { include: { faculty: true } } } }),
      this.prisma.academicLevel.findMany(),
      this.prisma.academicYear.findMany({ include: { semesters: true } }),
    ]);
    return {
      programmes: new Map(
        programmes
          .filter((p) => p.isActive && p.department.isActive && p.department.faculty.isActive)
          .map((p) => [p.code, p.id]),
      ),
      levels: new Map(levels.filter((l) => l.isActive).map((l) => [l.code, l.id])),
      years: new Map(
        years.map((y) => [
          y.label,
          { id: y.id, semesters: y.semesters.map((s) => ({ id: s.id, number: s.number, status: s.status })) },
        ]),
      ),
    };
  }
}
